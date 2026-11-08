// The loan rescue planner (owner's order, 2026-11-08): for a USDC loan on Aave's MAG7 spoke, how much
// USDC to repay, or how much of one stock to add as collateral, so that health stays at or above a
// target even if every stock price falls by a chosen share. Pure maths: it only fills the borrow
// panel's own Repay or Add fields (AaveBorrowPanel.tsx), which keep their exact approvals, checks and
// Builder Code; nothing here builds or sends a transaction.
//
// Health = Σ(collateral value × collateral factor) / debt (lib/lending/aaveBorrow.ts). A fall of `fall`
// in every stock price scales the collateral side by (1 − fall); the USDC debt does not move. So:
// - repay: the debt must come down to borrowPower × (1 − fall) / target;
// - add:   borrowPower must rise to target × debt / (1 − fall), and one token adds price × factor.

import { borrowPowerUsd, debtUsd, healthFactor, repayAllApproval, withChange, type AavePosition, type AaveReserve } from './aaveBorrow';

/** Target healths offered (1.5 by default: a common "comfortable" level, room for a ~33% fall). */
export const RESCUE_TARGETS = [1.3, 1.5, 2] as const;
/** Stress cases offered: every stock falls by this much together (0 = prices as they are). */
export const RESCUE_FALLS = [0, 0.1, 0.2, 0.3] as const;
/** Each amount is worked out for a target this much higher, so interest accrued before the block
 *  and rounding never leave the result a hair under the target. */
export const RESCUE_MARGIN = 0.002;
/** If health from these maths and the one Aave itself reports differ by more than this, the planner
 *  stays off: its amounts would rest on numbers the chain doesn't use (e.g. a collateral factor that
 *  changed since the loan was opened). */
export const RESCUE_MAX_MODEL_GAP = 0.02;

/** The position with every stock price lower by `fall` (0..1). */
export function stressed(pos: AavePosition, fall: number): AavePosition {
  return { ...pos, collateral: pos.collateral.map((c) => ({ ...c, priceUsd: c.priceUsd * (1 - fall) })) };
}

export interface RescueAdd {
  reserve: AaveReserve;
  /** Tokens to add (raw), rounded up. */
  addRaw: bigint;
  /** What the wallet holds of it (raw). */
  balanceRaw: bigint;
  /** Health after adding, under the stress. */
  healthAfter: number;
  /** When the wallet holds less than `addRaw`: adding all it holds, and the health that reaches. */
  partial?: { raw: bigint; healthAfter: number };
}

export type RescuePlan =
  | { kind: 'no-loan' }
  | { kind: 'paused'; why: string }
  | {
      kind: 'plan';
      /** Health under the stress before doing anything. */
      healthStressed: number;
      /** Already at or above the target under the stress: nothing to do. */
      safe: boolean;
      /** USDC to repay (raw, rounded up to a cent), `all` when only a full repay gets there. */
      repay: { raw: bigint; all: boolean; healthAfter: number; partial?: { raw: bigint; healthAfter: number } };
      /** One entry per stock the wallet holds that can count as collateral, in the panel's order. */
      adds: RescueAdd[];
    };

const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;

/** USDC (raw) to repay so health under `fall` reaches `target`. */
export function repayForTarget(pos: AavePosition, fall: number, target: number): { raw: bigint; all: boolean } {
  const goal = target * (1 + RESCUE_MARGIN);
  const allowedDebtUsd = (borrowPowerUsd(pos) * (1 - fall)) / goal;
  const repayUsd = debtUsd(pos) - allowedDebtUsd;
  if (repayUsd <= 0) return { raw: BigInt(0), all: false };
  // To USDC at the oracle's USDC price (the debt is valued at it), rounded up to a whole cent.
  const micro = BigInt(Math.ceil((repayUsd / (pos.usdcPriceUsd ?? 1)) * 1e6));
  const cents = ceilDiv(micro, BigInt(10_000)) * BigInt(10_000);
  return cents >= pos.debtRaw ? { raw: pos.debtRaw, all: true } : { raw: cents, all: false };
}

/** Tokens (raw) of one stock to add so health under `fall` reaches `target`; null if it can't count
 *  as collateral (factor 0) or a 100% fall is asked for. The smallest amount that gets there, found
 *  against the same health maths the panel shows (withChange), so a stock posted but not yet counted
 *  as collateral, which starts counting once added to, is handled the same way. */
export function addForTarget(pos: AavePosition, reserveId: number, fall: number, target: number): bigint | null {
  const c = pos.collateral.find((x) => x.reserve.reserveId === reserveId);
  if (!c || c.reserve.collateralFactor <= 0 || c.priceUsd <= 0 || fall >= 1) return null;
  const goal = target * (1 + RESCUE_MARGIN);
  const reaches = (raw: bigint) => healthFactor(stressed(withChange(pos, { reserveId, addRaw: raw }), fall)) >= goal;
  if (healthFactor(stressed(pos, fall)) >= goal) return BigInt(0);
  // Enough by construction: this much reaches the goal even if nothing else switches on.
  const needUsd = (goal * debtUsd(pos)) / (1 - fall) - borrowPowerUsd(pos);
  let hi = BigInt(Math.ceil((needUsd / (c.priceUsd * (1 - fall) * c.reserve.collateralFactor)) * 10 ** c.reserve.decimals)) + BigInt(1);
  while (!reaches(hi)) hi *= BigInt(2); // float rounding only; one doubling at most in practice
  let lo = BigInt(0);
  while (hi - lo > BigInt(1)) {
    const mid = (lo + hi) / BigInt(2);
    if (reaches(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The whole plan for one stress and target. `chainHealth` is the spoke's own getUserAccountData
 *  health (Infinity with no debt); `balances` the wallet's raw balance per reserve id. */
export function planRescue(
  pos: AavePosition,
  opts: { fall: number; target: number; chainHealth: number; balances: Map<number, bigint>; usdcBalance: bigint },
): RescuePlan {
  if (pos.debtRaw === BigInt(0)) return { kind: 'no-loan' };
  const model = healthFactor(pos);
  if (!Number.isFinite(opts.chainHealth) || !Number.isFinite(model) || Math.abs(model / opts.chainHealth - 1) > RESCUE_MAX_MODEL_GAP) {
    return { kind: 'paused', why: `Aave reports health ${Number.isFinite(opts.chainHealth) ? opts.chainHealth.toFixed(2) : 'unknown'} and these maths give ${model.toFixed(2)}` };
  }
  // Inside the gate the two can still differ by up to 2% (Aave keeps the factors a user's loan was
  // opened with, and a repay or add doesn't refresh them). Work to whichever is lower: every health
  // shown is scaled down by `k`, and amounts aim at target / k, so the result reaches the target on
  // Aave's own number (from the real-money review, 2026-11-08).
  const k = Math.min(1, opts.chainHealth / model);
  const aim = opts.target / k;
  const shown = (h: number) => h * k;
  const healthStressed = shown(healthFactor(stressed(pos, opts.fall)));
  if (healthStressed >= opts.target) return { kind: 'plan', healthStressed, safe: true, repay: { raw: BigInt(0), all: false, healthAfter: healthStressed }, adds: [] };
  const repay = repayForTarget(pos, opts.fall, aim);
  const repaidHealth = (raw: bigint) => shown(healthFactor(stressed(withChange(pos, { repayRaw: raw }), opts.fall)));
  const adds: RescueAdd[] = pos.collateral.flatMap((c) => {
    const balanceRaw = opts.balances.get(c.reserve.reserveId) ?? BigInt(0);
    if (balanceRaw === BigInt(0)) return [];
    const addRaw = addForTarget(pos, c.reserve.reserveId, opts.fall, aim);
    if (addRaw == null || addRaw === BigInt(0)) return [];
    const after = (raw: bigint) => shown(healthFactor(stressed(withChange(pos, { reserveId: c.reserve.reserveId, addRaw: raw }), opts.fall)));
    // Short of the target, all the wallet holds still helps: say how far it gets.
    const partial = balanceRaw < addRaw ? { raw: balanceRaw, healthAfter: after(balanceRaw) } : undefined;
    return [{ reserve: c.reserve, addRaw, balanceRaw, healthAfter: after(addRaw), partial }];
  });
  // A full repay approves the debt plus a little for interest until the block (repayAllApproval); with
  // less than that in the wallet, interest could make repay(MAX) revert, so offer the balance instead.
  // A fixed repay must stay under the debt (the panel asks for "All" otherwise): at most debt − 1 unit.
  const partialRepay = opts.usdcBalance < pos.debtRaw ? opts.usdcBalance : pos.debtRaw - BigInt(1);
  const covers = repay.all ? opts.usdcBalance >= repayAllApproval(pos.debtRaw) : opts.usdcBalance >= repay.raw;
  return {
    kind: 'plan',
    healthStressed,
    safe: false,
    repay: {
      ...repay,
      healthAfter: repaidHealth(repay.raw),
      partial: !covers && opts.usdcBalance > BigInt(0) ? { raw: partialRepay, healthAfter: repaidHealth(partialRepay) } : undefined,
    },
    adds,
  };
}
