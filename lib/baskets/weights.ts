// Pure weighting math for "Afterbook Basis Tilt". No I/O and no server-only
// imports, so it can be unit-checked in isolation and reused by both the
// /baskets page and whatever publishes strategy versions to Glider.
//
// Weights come from Afterbook's own on-chain reads only: real pool depth and
// cash-vs-chain basis. Basis is only counted for liquid pools — a thin pool's
// basis is mostly noise (see lib/liquidity.ts), so tilting toward it would
// reward the noisiest names.

import { isLiquid } from '../liquidity';

export interface WeightInput {
  symbol: string;
  depthUsd: number | null;
  /** Signed basis in bp; the sign is dropped, only the size of the gap tilts. */
  basisBp: number | null;
}

export interface BasketWeight {
  symbol: string;
  /** Percent as a string with exactly 2 decimals — Glider's weight format. */
  weight: string;
  /** Same value in hundredths of a percent, for exact arithmetic. */
  weightHundredths: number;
  depthScore: number;
  basisScore: number;
}

export const DEPTH_SHARE = 0.5;
export const MIN_WEIGHT = 0.02;
export const MAX_WEIGHT = 0.25;

/** Rounds a fractional distribution to integer hundredths of a percent that
 *  sum to exactly 10_000 (largest-remainder), so the weights always total
 *  "100" as Glider requires. */
function toHundredths(fractions: number[]): number[] {
  const scaled = fractions.map((f) => f * 10_000);
  const floors = scaled.map(Math.floor);
  let short = 10_000 - floors.reduce((a, b) => a + b, 0);
  const order = scaled
    .map((s, i) => ({ i, rem: s - Math.floor(s) }))
    .sort((a, b) => b.rem - a.rem);
  for (const { i } of order) {
    if (short <= 0) break;
    floors[i] += 1;
    short -= 1;
  }
  return floors;
}

/** Scale the raw scores by a single factor k and clamp each to [min, max],
 *  choosing k by bisection so the clamped weights sum to exactly 1. Sum is
 *  monotonic in k, and feasibility (n*min <= 1 <= n*max) guarantees a solution.
 *  Unlike clamp-then-redistribute, this can't strand weight when every
 *  unclamped name ends up pinned to a bound. */
function clampToSimplex(raw: number[], min: number, max: number): number[] {
  const total = raw.reduce((a, b) => a + b, 0);
  const base = total > 0 ? raw.map((r) => r / total) : raw.map(() => 1 / raw.length);
  const at = (k: number) => base.map((r) => Math.min(max, Math.max(min, r * k)));
  const sum = (w: number[]) => w.reduce((a, b) => a + b, 0);
  let lo = 0;
  let hi = 1;
  while (sum(at(hi)) < 1 && hi < 1e12) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (sum(at(mid)) < 1) lo = mid; else hi = mid;
  }
  return at(hi);
}

export function computeTiltWeights(inputs: WeightInput[]): BasketWeight[] {
  const n = inputs.length;
  if (n === 0) return [];
  if (n * MIN_WEIGHT > 1 || n * MAX_WEIGHT < 1) {
    throw new Error(`weight bounds infeasible for ${n} assets`);
  }

  const depths = inputs.map((r) => Math.max(0, r.depthUsd ?? 0));
  const depthTotal = depths.reduce((a, b) => a + b, 0);
  const depthScore = depths.map((d) => (depthTotal > 0 ? d / depthTotal : 1 / n));

  const basisAbs = inputs.map((r) =>
    isLiquid({ depthUsd: r.depthUsd }) && r.basisBp != null ? Math.abs(r.basisBp) : 0,
  );
  const basisTotal = basisAbs.reduce((a, b) => a + b, 0);
  // No liquid name has a basis reading: fall back to depth alone rather than
  // splitting the basis half evenly and diluting the tilt.
  const basisScore = basisAbs.map((b) => (basisTotal > 0 ? b / basisTotal : 0));
  const depthShare = basisTotal > 0 ? DEPTH_SHARE : 1;

  const raw = inputs.map((_, i) => depthShare * depthScore[i] + (1 - depthShare) * basisScore[i]);
  const bounded = clampToSimplex(raw, MIN_WEIGHT, MAX_WEIGHT);
  const hundredths = toHundredths(bounded);

  return inputs.map((r, i) => ({
    symbol: r.symbol,
    weight: (hundredths[i] / 100).toFixed(2),
    weightHundredths: hundredths[i],
    depthScore: depthScore[i],
    basisScore: basisScore[i],
  }));
}
