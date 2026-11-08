// The loan rescue planner's maths (lib/lending/rescue.ts): the repay or the collateral that brings a
// loan's health back to a target under a price fall, never a hair short, and never a plan built on
// numbers the chain disagrees with.
import { describe, expect, it } from 'vitest';
import { healthFactor, withChange, type AavePosition, type AaveReserve } from '../lib/lending/aaveBorrow';
import { repayAllApproval } from '../lib/lending/aaveBorrow';
import { addForTarget, planRescue, repayForTarget, RESCUE_MARGIN, stressed } from '../lib/lending/rescue';

const NVDA: AaveReserve = { reserveId: 3, symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', decimals: 8, collateralFactor: 0.7 };
const AAPL: AaveReserve = { reserveId: 1, symbol: 'AAPLc', token: '0xb200000000000000000000c2e324d24d7eecd1fb', decimals: 8, collateralFactor: 0.78 };
const tokens = (n: number) => BigInt(Math.round(n * 1e8));
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

// 10 NVDAc at $200 (cf 0.7) = $1,400 of borrow power; $1,000 borrowed: health 1.4.
const pos = (debt = 1000, over: Partial<AavePosition> = {}): AavePosition => ({
  collateral: [
    { reserve: NVDA, suppliedRaw: tokens(10), enabled: true, priceUsd: 200 },
    { reserve: AAPL, suppliedRaw: BigInt(0), enabled: false, priceUsd: 250 },
  ],
  debtRaw: usdc(debt),
  ...over,
});
const hfUnder = (p: AavePosition, fall: number) => healthFactor(stressed(p, fall));
const balances = new Map([[3, tokens(100)], [1, tokens(100)]]);

describe('repayForTarget', () => {
  it('repays down to the debt that leaves the target under the fall, rounded up to a cent', () => {
    // Fall 20%: power 1,120. Target 1.5 (+margin): debt at most 1120 / 1.503 = 745.18…, so repay 254.82…
    const r = repayForTarget(pos(), 0.2, 1.5);
    expect(r.all).toBe(false);
    expect(r.raw % BigInt(10_000)).toBe(BigInt(0));
    expect(Number(r.raw) / 1e6).toBeCloseTo(1000 - 1120 / (1.5 * (1 + RESCUE_MARGIN)), 1);
    expect(hfUnder(withChange(pos(), { repayRaw: r.raw }), 0.2)).toBeGreaterThanOrEqual(1.5);
    // One cent less misses the margin-padded goal, but still reaches the plain target.
    expect(hfUnder(withChange(pos(), { repayRaw: r.raw - BigInt(10_000) }), 0.2)).toBeLessThan(1.5 * (1 + RESCUE_MARGIN));
    expect(hfUnder(withChange(pos(), { repayRaw: r.raw - BigInt(10_000) }), 0.2)).toBeGreaterThanOrEqual(1.5);
  });
  it('values the debt at the oracle USDC price', () => {
    const at101 = repayForTarget(pos(1000, { usdcPriceUsd: 1.01 }), 0.2, 1.5);
    expect(hfUnder(withChange(pos(1000, { usdcPriceUsd: 1.01 }), { repayRaw: at101.raw }), 0.2)).toBeGreaterThanOrEqual(1.5);
  });
  it('says "all" when only a full repay gets there', () => {
    const r = repayForTarget(pos(1000, { collateral: [{ reserve: NVDA, suppliedRaw: tokens(10), enabled: true, priceUsd: 0.0001 }] }), 0.3, 2);
    expect(r).toEqual({ raw: usdc(1000), all: true });
  });
  it('is zero when already there', () => {
    expect(repayForTarget(pos(500), 0.1, 1.5).raw).toBe(BigInt(0));
  });
});

describe('addForTarget', () => {
  it('adds the least of an enabled stock that reaches the target under the fall', () => {
    const raw = addForTarget(pos(), 3, 0.2, 1.5)!;
    const goal = 1.5 * (1 + RESCUE_MARGIN);
    expect(hfUnder(withChange(pos(), { reserveId: 3, addRaw: raw }), 0.2)).toBeGreaterThanOrEqual(goal);
    expect(hfUnder(withChange(pos(), { reserveId: 3, addRaw: raw - BigInt(1) }), 0.2)).toBeLessThan(goal);
  });
  it('adds a stock not yet used as collateral (adding turns it on)', () => {
    const raw = addForTarget(pos(), 1, 0.2, 1.5)!;
    expect(hfUnder(withChange(pos(), { reserveId: 1, addRaw: raw }), 0.2)).toBeGreaterThanOrEqual(1.5);
    // (1.503 × 1000 / 0.8 − 1120/0.8) / (250 × 0.78) ≈ 2.4551 AAPLc
    expect(Number(raw) / 1e8).toBeCloseTo((1.5 * (1 + RESCUE_MARGIN) * 1000 - 1120) / (250 * 0.8 * 0.78), 3);
  });
  it('counts what is already posted but switched off: it starts counting once added to', () => {
    const p = pos(1000, {
      collateral: [
        { reserve: NVDA, suppliedRaw: tokens(10), enabled: true, priceUsd: 200 },
        { reserve: AAPL, suppliedRaw: tokens(2), enabled: false, priceUsd: 250 },
      ],
    });
    const off = addForTarget(p, 1, 0.2, 1.5)!;
    const fresh = addForTarget(pos(), 1, 0.2, 1.5)!;
    expect(off).toBeLessThan(fresh);
    expect(hfUnder(withChange(p, { reserveId: 1, addRaw: off }), 0.2)).toBeGreaterThanOrEqual(1.5);
  });
  it('is null for a stock that cannot be collateral, and zero when already there', () => {
    const zero = pos(1000, { collateral: [{ reserve: { ...NVDA, collateralFactor: 0 }, suppliedRaw: tokens(10), enabled: true, priceUsd: 200 }] });
    expect(addForTarget(zero, 3, 0.2, 1.5)).toBeNull();
    expect(addForTarget(pos(500), 3, 0.1, 1.5)).toBe(BigInt(0));
  });
});

describe('planRescue', () => {
  const chain = (p: AavePosition) => healthFactor(p);
  it('has nothing to do without a loan', () => {
    expect(planRescue(pos(0), { fall: 0.2, target: 1.5, chainHealth: Infinity, balances, usdcBalance: usdc(10_000) })).toEqual({ kind: 'no-loan' });
  });
  it('pauses when its health differs from what Aave reports by over 2%', () => {
    const plan = planRescue(pos(), { fall: 0.2, target: 1.5, chainHealth: 1.4 * 1.03, balances, usdcBalance: usdc(10_000) });
    expect(plan.kind).toBe('paused');
    expect(planRescue(pos(), { fall: 0.2, target: 1.5, chainHealth: 1.4 * 1.01, balances, usdcBalance: usdc(10_000) }).kind).toBe('plan');
  });
  it('says safe, with nothing to fill, when the fall still leaves the target', () => {
    const plan = planRescue(pos(500), { fall: 0.1, target: 1.5, chainHealth: chain(pos(500)), balances, usdcBalance: usdc(10_000) });
    expect(plan).toMatchObject({ kind: 'plan', safe: true, adds: [], repay: { raw: BigInt(0) } });
  });
  it('gives a repay and an add per stock the wallet holds, each reaching the target', () => {
    const plan = planRescue(pos(), { fall: 0.2, target: 1.5, chainHealth: chain(pos()), balances: new Map([[1, tokens(1)]]), usdcBalance: usdc(10_000) });
    if (plan.kind !== 'plan') throw new Error(plan.kind);
    expect(plan.safe).toBe(false);
    expect(plan.healthStressed).toBeCloseTo(1.12, 5);
    expect(plan.repay.healthAfter).toBeGreaterThanOrEqual(1.5);
    // NVDAc isn't in the wallet, so only AAPLc is offered; 1 AAPLc held is less than needed, and that is reported.
    expect(plan.adds.map((a) => a.reserve.symbol)).toEqual(['AAPLc']);
    expect(plan.adds[0].balanceRaw).toBeLessThan(plan.adds[0].addRaw);
    expect(plan.adds[0].healthAfter).toBeGreaterThanOrEqual(1.5);
    // Short: adding all 1 AAPLc held helps, but not up to the target.
    expect(plan.adds[0].partial?.raw).toBe(tokens(1));
    expect(plan.adds[0].partial!.healthAfter).toBeGreaterThan(plan.healthStressed);
    expect(plan.adds[0].partial!.healthAfter).toBeLessThan(1.5);
    // The wallet covers the repay, so there is no partial one.
    expect(plan.repay.partial).toBeUndefined();
  });
  it('offers the USDC the wallet holds when it is short of the full repay', () => {
    const plan = planRescue(pos(), { fall: 0.2, target: 1.5, chainHealth: chain(pos()), balances, usdcBalance: usdc(100) });
    if (plan.kind !== 'plan') throw new Error(plan.kind);
    expect(plan.repay.partial?.raw).toBe(usdc(100));
    expect(plan.repay.partial!.healthAfter).toBeCloseTo(1120 / 900, 5);
    expect(planRescue(pos(), { fall: 0.2, target: 1.5, chainHealth: chain(pos()), balances, usdcBalance: BigInt(0) }).kind === 'plan').toBe(true);
  });
  it('reaches the target on Aave’s own health when Aave reads up to 2% lower (from the review)', () => {
    const p = pos();
    const ratio = 0.981; // Aave 1.9% under these maths: inside the gate
    const plan = planRescue(p, { fall: 0.2, target: 1.5, chainHealth: chain(p) * ratio, balances, usdcBalance: usdc(10_000) });
    if (plan.kind !== 'plan') throw new Error(plan.kind);
    // What Aave would read after the step (its older factors stay): these maths × ratio.
    expect(hfUnder(withChange(p, { repayRaw: plan.repay.raw }), 0.2) * ratio).toBeGreaterThanOrEqual(1.5);
    for (const a of plan.adds) expect(hfUnder(withChange(p, { reserveId: a.reserve.reserveId, addRaw: a.addRaw }), 0.2) * ratio).toBeGreaterThanOrEqual(1.5);
    // Shown healths are on Aave's scale too.
    expect(plan.healthStressed).toBeCloseTo(1.12 * ratio, 5);
    // When Aave reads higher, nothing is scaled up.
    const up = planRescue(p, { fall: 0.2, target: 1.5, chainHealth: chain(p) * 1.015, balances, usdcBalance: usdc(10_000) });
    if (up.kind !== 'plan') throw new Error(up.kind);
    expect(up.healthStressed).toBeCloseTo(1.12, 5);
  });
  it('offers a full repay only with the interest buffer in the wallet; otherwise just under the debt', () => {
    const p = pos(1000, { collateral: [{ reserve: NVDA, suppliedRaw: tokens(10), enabled: true, priceUsd: 0.0001 }] });
    const exactlyDebt = planRescue(p, { fall: 0.3, target: 2, chainHealth: chain(p), balances, usdcBalance: usdc(1000) });
    if (exactlyDebt.kind !== 'plan') throw new Error(exactlyDebt.kind);
    expect(exactlyDebt.repay.all).toBe(true);
    expect(exactlyDebt.repay.partial?.raw).toBe(usdc(1000) - BigInt(1));
    const buffered = planRescue(p, { fall: 0.3, target: 2, chainHealth: chain(p), balances, usdcBalance: repayAllApproval(usdc(1000)) });
    if (buffered.kind !== 'plan') throw new Error(buffered.kind);
    expect(buffered.repay.partial).toBeUndefined();
  });
});
