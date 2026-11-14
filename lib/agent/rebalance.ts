// Rebalance rules on /rules (owner, 2026-11-14): a rule holds target weights for 2-4 stocks, and each
// scheduled run tops the basket up with new USDC, buy-only, never selling. The run's amount goes to the
// stocks below their target share of the basket after this run, in proportion to how far each is below
// (with nothing held, that is the target weights). Money that would only go past a stock's target share
// (when the ones below can't be bought right now) stays as cash. The wallet's holdings are read onchain at run
// time by the page; the server prices them and runs the plan's own checks (app/api/agent/rebalance-check).
// Sell-and-buy rebalancing is for after the quest. Pure and browser-safe: no server imports.

import { normalizeLegs, type BasketLeg } from '../build/customBasket';
import { PLAN_LIMITS } from './limits';

export interface Target {
  symbol: string;
  /** Whole percent; a rule's targets sum to 100. */
  weightPct: number;
}

export const REBALANCE_LIMITS = {
  /** The basket buy takes 2 to 4 stocks (MIN_LEGS..MAX_LEGS in lib/build/customBasket.ts). */
  minTargets: 2,
  maxTargets: 4,
} as const;

/** 2-4 distinct known stocks, whole-percent weights of 1-99 that sum to 100. */
export function isTargets(v: unknown, known: (symbol: string) => boolean): v is Target[] {
  if (!Array.isArray(v) || v.length < REBALANCE_LIMITS.minTargets || v.length > REBALANCE_LIMITS.maxTargets) return false;
  const seen = new Set<string>();
  for (const t of v) {
    if (!t || typeof t !== 'object') return false;
    const { symbol, weightPct } = t as Record<string, unknown>;
    if (typeof symbol !== 'string' || !known(symbol) || seen.has(symbol)) return false;
    if (typeof weightPct !== 'number' || !Number.isInteger(weightPct) || weightPct < 1 || weightPct > 99) return false;
    seen.add(symbol);
  }
  return (v as Target[]).reduce((s, t) => s + t.weightPct, 0) === 100;
}

/**
 * Holdings worth less than this count as nothing held (recheck, 2026-11-14): a 1-wei airdrop or the dust
 * a partial sell leaves must not switch a first run to the strict rule or show "100% now". One rule, used
 * by the split, the plan and the drift view.
 */
export const dustUsd = (budgetUsd: number) => Math.max(1, budgetUsd * 0.01);
export const nothingHeld = (heldUsd: number, budgetUsd: number) => heldUsd < dustUsd(budgetUsd);

export interface DriftRow {
  symbol: string;
  valueUsd: number;
  /** Share of what the wallet holds of the rule's stocks now; null when it holds none of them. */
  currentPct: number | null;
  targetPct: number;
  /** currentPct − targetPct, in percentage points; null when it holds none. */
  driftPts: number | null;
}

/** Where the holdings stand against the targets (the drift view each run shows). Dust (`nothingHeld`)
 *  has no percentages: it counts as nothing held. */
export function driftRows(targets: Target[], valuesUsd: Record<string, number>, budgetUsd = 0): DriftRow[] {
  const total = targets.reduce((s, t) => s + (valuesUsd[t.symbol] ?? 0), 0);
  const dust = budgetUsd > 0 ? nothingHeld(total, budgetUsd) : total <= 0;
  return targets.map((t) => {
    const valueUsd = valuesUsd[t.symbol] ?? 0;
    const currentPct = !dust && total > 0 ? (valueUsd / total) * 100 : null;
    return { symbol: t.symbol, valueUsd, currentPct, targetPct: t.weightPct, driftPts: currentPct == null ? null : currentPct - t.weightPct };
  });
}

/**
 * How a run's `budgetUsd` is split over `among` (the targets that can be bought now). Each stock's
 * shortfall is how far it is below its target share of (holdings + this run). Over all the targets the
 * shortfalls add up to at least the run, so with every target buyable the run goes to those below, in
 * proportion to the shortfall (with nothing held, or exactly on target, that is the target weights).
 * When some targets can't be bought now, each buyable stock gets at most its own shortfall and the rest
 * stays as cash: the run never goes into a stock beyond its target share (review, 2026-11-14: a run whose
 * under-target stocks failed their checks went all into the one already over, making the drift worse).
 */
export function topUpSplit(
  targets: Target[],
  valuesUsd: Record<string, number>,
  budgetUsd: number,
  among: string[] = targets.map((t) => t.symbol),
  /** Money from stocks left out only for the $10 swap minimum: spread over `among` by target weight, on top. */
  spreadUsd = 0,
): { symbol: string; usd: number }[] {
  const heldUsd = targets.reduce((s, t) => s + (valuesUsd[t.symbol] ?? 0), 0);
  const total = heldUsd + budgetUsd;
  const pool = targets.filter((t) => among.includes(t.symbol));
  if (!pool.length || budgetUsd <= 0) return [];
  const short = pool.map((t) => shortfallUsd(t, valuesUsd, total));
  const sumShort = short.reduce((s, x) => s + x, 0);
  const sumW = pool.reduce((s, t) => s + t.weightPct, 0);
  // Nothing held yet (owner, 2026-11-14): there is no balance to keep in line, and money left in the wallet
  // isn't carried to later runs, so the whole run goes to the buyable stocks at their target weights; the
  // next runs put more into any that sat this one out, since they're then the most under target.
  const fresh = nothingHeld(heldUsd, budgetUsd);
  const base = pool.map((t, i) => (fresh ? (budgetUsd * t.weightPct) / sumW : sumShort > budgetUsd ? (budgetUsd * short[i]) / sumShort : short[i]));
  const spread = Math.max(0, Math.min(spreadUsd, budgetUsd - base.reduce((s, x) => s + x, 0)));
  return pool.map((t, i) => ({ symbol: t.symbol, usd: Math.floor((base[i] + (spread * t.weightPct) / sumW) * 100) / 100 }));
}

/** How far a stock is below its target share of `totalAfterUsd` (holdings + this run), 0 if it isn't. */
export function shortfallUsd(t: Target, valuesUsd: Record<string, number>, totalAfterUsd: number): number {
  return Math.max(0, (t.weightPct / 100) * totalAfterUsd - (valuesUsd[t.symbol] ?? 0));
}

/**
 * The split, with every stock at the swap minimum: a stock whose share is under $10 is left out, its money
 * goes to the rest by target weight, and the run is split again (deepest shortfall first keeps its place). Returns the legs (at least
 * one) and the stocks left out for being too small.
 */
export function topUpLegs(
  targets: Target[],
  valuesUsd: Record<string, number>,
  budgetUsd: number,
  among: string[],
  /** Stocks already left out for the $10 minimum at a later stage (after sizing or the percent split):
   *  their share of the split is spread over the rest, the same as one dropped here. */
  preDropped: string[] = [],
): { legs: { symbol: string; usd: number }[]; tooSmall: string[] } {
  const tooSmall: string[] = [];
  let pool = [...among];
  if (!pool.length) return { legs: [], tooSmall };
  for (;;) {
    // What the dropped stocks would get in a plain split with them in (no spread on top), so a spread
    // share is never counted twice when a second stock is dropped (review, 2026-11-14).
    const dropped = [...preDropped, ...tooSmall];
    const spreadUsd = dropped.length
      ? topUpSplit(targets, valuesUsd, budgetUsd, [...pool, ...dropped]).filter((l) => dropped.includes(l.symbol)).reduce((s, l) => s + l.usd, 0)
      : 0;
    const legs = topUpSplit(targets, valuesUsd, budgetUsd, pool, spreadUsd).filter((l) => l.usd > 0);
    const small = legs.filter((l) => l.usd < PLAN_LIMITS.minLegUsd);
    if (!small.length) return { legs, tooSmall };
    // Drop the smallest one and split again. It didn't fail a check, only the minimum, so the money it had
    // goes to the others by target weight (at most $10 a dropped stock past their target share).
    const smallest = small.reduce((a, b) => (b.usd < a.usd ? b : a));
    tooSmall.push(smallest.symbol);
    pool = pool.filter((s) => s !== smallest.symbol);
    if (!pool.length) return { legs: [], tooSmall };
  }
}

/**
 * Whole-percent weights for sized amounts that let the basket buy spend the most without giving any stock
 * more than it was sized for: the largest whole-dollar total T for which every stock still gets at least
 * 1% with floor(100 × usd / T) percent, the percents trimmed (from the largest) to add to exactly 100.
 * Rounding to the nearest percent instead could leave much of a lopsided run unspent (99.5/0.5 → 99/1
 * spends at most 100× the small stock).
 */
export function bestWholePercents(sized: { symbol: string; usd: number }[]): BasketLeg[] {
  const total = Math.floor(sized.reduce((s, l) => s + l.usd, 0));
  const pctAt = (t: number) => sized.map((l) => Math.floor((l.usd * 100) / t + 1e-9));
  const fits = (t: number) => {
    const p = pctAt(t);
    return p.every((x) => x >= 1) && p.reduce((s, x) => s + x, 0) >= 100;
  };
  let lo = 1;
  let hi = Math.max(1, total);
  if (!fits(lo)) return normalizeLegs(sized.map((l) => ({ symbol: l.symbol, weight: l.usd })));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const pcts = pctAt(lo);
  for (let extra = pcts.reduce((s, x) => s + x, 0) - 100; extra > 0; extra--) {
    const i = pcts.reduce((b, x, j) => (x > pcts[b] ? j : b), 0);
    pcts[i] -= 1;
  }
  return sized.map((l, i) => ({ symbol: l.symbol, weightPct: pcts[i] }));
}

/**
 * Sized legs → the basket buy's whole-percent weights and the total it may spend, so that the buy's split
 * gives no stock more than it was sized for (the same rule as "Describe a basket"). A stock that would
 * fall under the swap minimum after the split is returned in `dropped`; the caller drops it and calls again.
 */
export function wholePercentBasket(sized: { symbol: string; usd: number }[]): { basket: BasketLeg[]; investedUsd: number; legUsd: Record<string, number>; dropped: string[] } {
  const basket = bestWholePercents(sized);
  const zero = sized.filter((l) => !basket.some((b) => b.symbol === l.symbol && b.weightPct > 0)).map((l) => l.symbol);
  if (zero.length) return { basket, investedUsd: 0, legUsd: {}, dropped: zero };
  const w = (s: string) => basket.find((b) => b.symbol === s)!.weightPct;
  const investedUsd = Math.floor(Math.min(...sized.map((l) => (l.usd * 100) / w(l.symbol))) + 1e-9);
  const legUsd = Object.fromEntries(sized.map((l) => [l.symbol, Math.floor(investedUsd * w(l.symbol)) / 100]));
  const tiny = sized.filter((l) => legUsd[l.symbol] < PLAN_LIMITS.minLegUsd).sort((a, b) => a.usd - b.usd);
  return { basket, investedUsd, legUsd, dropped: tiny.length ? [tiny[0].symbol] : [] };
}
