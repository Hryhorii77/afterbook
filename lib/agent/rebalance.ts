// Rebalance rules on /rules (owner, 2026-11-14): a rule holds target weights for 2-4 stocks, and each
// scheduled run tops the basket up with new USDC, buy-only, never selling. The run's amount goes to the
// stocks below target, in proportion to how far each is below; if none is below (or the ones below can't
// be bought right now), it is split by the target weights. The wallet's holdings are read onchain at run
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

export interface DriftRow {
  symbol: string;
  valueUsd: number;
  /** Share of what the wallet holds of the rule's stocks now; null when it holds none of them. */
  currentPct: number | null;
  targetPct: number;
  /** currentPct − targetPct, in percentage points; null when it holds none. */
  driftPts: number | null;
}

/** Where the holdings stand against the targets (the drift view each run shows). */
export function driftRows(targets: Target[], valuesUsd: Record<string, number>): DriftRow[] {
  const total = targets.reduce((s, t) => s + (valuesUsd[t.symbol] ?? 0), 0);
  return targets.map((t) => {
    const valueUsd = valuesUsd[t.symbol] ?? 0;
    const currentPct = total > 0 ? (valueUsd / total) * 100 : null;
    return { symbol: t.symbol, valueUsd, currentPct, targetPct: t.weightPct, driftPts: currentPct == null ? null : currentPct - t.weightPct };
  });
}

/**
 * How a run's `budgetUsd` is split over `among` (the targets that can be bought now). Each stock's
 * shortfall is how far it is below its target share of (holdings + this run); the run goes to those
 * below, in proportion to the shortfall, so no stock ends up above its target from this run. When the
 * shortfalls add up to less than the run, each is filled and the rest goes by target weight (with none
 * below target: all of it by target weight).
 */
export function topUpSplit(targets: Target[], valuesUsd: Record<string, number>, budgetUsd: number, among: string[] = targets.map((t) => t.symbol)): { symbol: string; usd: number }[] {
  const total = targets.reduce((s, t) => s + (valuesUsd[t.symbol] ?? 0), 0) + budgetUsd;
  const pool = targets.filter((t) => among.includes(t.symbol));
  if (!pool.length || budgetUsd <= 0) return [];
  const short = pool.map((t) => Math.max(0, (t.weightPct / 100) * total - (valuesUsd[t.symbol] ?? 0)));
  const sumShort = short.reduce((s, x) => s + x, 0);
  const sumW = pool.reduce((s, t) => s + t.weightPct, 0);
  // Shortfalls bigger than the run: the run in proportion to them. Smaller (some targets can't be bought
  // now, or none is below target): fill each shortfall, then the rest by target weight.
  const rest = Math.max(0, budgetUsd - sumShort);
  return pool.map((t, i) => {
    const share = sumShort >= budgetUsd ? (budgetUsd * short[i]) / sumShort : short[i] + (rest * t.weightPct) / sumW;
    return { symbol: t.symbol, usd: Math.floor(share * 100) / 100 };
  });
}

/**
 * The split, with every stock at the swap minimum: a stock whose share is under $10 is left out and the
 * run is split again over the rest (deepest shortfall first keeps its place). Returns the legs (at least
 * one) and the stocks left out for being too small.
 */
export function topUpLegs(targets: Target[], valuesUsd: Record<string, number>, budgetUsd: number, among: string[]): { legs: { symbol: string; usd: number }[]; tooSmall: string[] } {
  let pool = [...among];
  const tooSmall: string[] = [];
  for (;;) {
    const legs = topUpSplit(targets, valuesUsd, budgetUsd, pool).filter((l) => l.usd > 0);
    const small = legs.filter((l) => l.usd < PLAN_LIMITS.minLegUsd);
    if (!small.length) return { legs, tooSmall };
    // Drop the smallest one and split again; the money it had goes to the others.
    const smallest = small.reduce((a, b) => (b.usd < a.usd ? b : a));
    tooSmall.push(smallest.symbol);
    pool = pool.filter((s) => s !== smallest.symbol);
    if (!pool.length) return { legs: [], tooSmall };
  }
}

/**
 * Sized legs → the basket buy's whole-percent weights and the total it may spend, so that the buy's split
 * gives no stock more than it was sized for (the same rule as "Describe a basket"). A stock that would
 * round to 0% or fall under the swap minimum after the split is returned in `dropped`; the caller drops
 * it and calls again.
 */
export function wholePercentBasket(sized: { symbol: string; usd: number }[]): { basket: BasketLeg[]; investedUsd: number; legUsd: Record<string, number>; dropped: string[] } {
  const basket = normalizeLegs(sized.map((l) => ({ symbol: l.symbol, weight: l.usd })));
  const zero = sized.filter((l) => !basket.some((b) => b.symbol === l.symbol)).map((l) => l.symbol);
  if (zero.length) return { basket, investedUsd: 0, legUsd: {}, dropped: zero };
  const w = (s: string) => basket.find((b) => b.symbol === s)!.weightPct;
  const investedUsd = Math.floor(Math.min(...sized.map((l) => (l.usd * 100) / w(l.symbol))));
  const legUsd = Object.fromEntries(sized.map((l) => [l.symbol, Math.floor(investedUsd * w(l.symbol)) / 100]));
  const tiny = sized.filter((l) => legUsd[l.symbol] < PLAN_LIMITS.minLegUsd).sort((a, b) => a.usd - b.usd);
  return { basket, investedUsd, legUsd, dropped: tiny.length ? [tiny[0].symbol] : [] };
}
