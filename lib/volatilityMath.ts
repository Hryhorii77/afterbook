// Pure math split out of lib/volatility.ts, deliberately its own module (no
// './redis' import) so client components can import it without pulling a
// Redis client into the browser bundle — same reason lib/liquidity.ts is
// its own module rather than living in lib/tape.ts. lib/volatility.ts
// re-exports everything here for existing server-side importers.

const MIN_SAMPLES = 20;

/** LPs plan in week-ish increments, and a 7-day horizon keeps the realized-
 *  vol estimate from a 30-day sample window reasonably relevant to it.
 *  Exported so the UI never hardcodes a number that could drift from what's
 *  actually computed. */
export const IN_RANGE_HORIZON_DAYS = 7;

export interface PriceSample {
  ts: number;
  priceUsd: number;
}

// Standard Abramowitz-Stegun approximation of the normal CDF — pure math, no
// dependency, accurate to ~1.5e-7.
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const poly = t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const cdf = 1 - d * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

/** Time-normalized realized volatility from log-returns, annualized. Robust
 *  to the irregular spacing this throttled/opportunistic sampling produces
 *  (unlike a naive per-sample stddev, which implicitly assumes even
 *  spacing) — this sums squared log-returns and normalizes by elapsed time
 *  directly, the same quadratic-variation-style estimator used for
 *  irregularly-sampled series generally. */
export function computeAnnualizedVol(samples: PriceSample[]): number | null {
  if (samples.length < MIN_SAMPLES) return null;

  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  let sumSqReturns = 0;
  let sumYears = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dtYears = (sorted[i].ts - sorted[i - 1].ts) / (365 * 86_400_000);
    if (dtYears <= 0) continue;
    const logReturn = Math.log(sorted[i].priceUsd / sorted[i - 1].priceUsd);
    sumSqReturns += logReturn * logReturn;
    sumYears += dtYears;
  }
  if (sumYears <= 0) return null;

  return Math.sqrt(sumSqReturns / sumYears);
}

/**
 * P(price ends up back inside [rangeLowUsd, rangeHighUsd] at the fixed
 * IN_RANGE_HORIZON_DAYS horizon) — a point-in-time estimate, not "never left
 * the range at any moment before then" (true first-passage probability needs
 * reflection-principle math this doesn't attempt). Assumes zero-drift
 * lognormal price motion, which is the standard simplification for this kind
 * of estimate since predicting real-world drift isn't something this app
 * can do reliably anyway.
 */
export function computeInRangeProbabilityPct(
  samples: PriceSample[],
  currentPriceUsd: number,
  rangeLowUsd: number,
  rangeHighUsd: number,
): number | null {
  if (currentPriceUsd <= 0 || rangeLowUsd <= 0 || rangeHighUsd <= rangeLowUsd) return null;

  const sigma = computeAnnualizedVol(samples);
  if (sigma == null || sigma <= 0) return null;

  const T = IN_RANGE_HORIZON_DAYS / 365;
  const denom = sigma * Math.sqrt(T);
  const dHigh = Math.log(rangeHighUsd / currentPriceUsd) / denom;
  const dLow = Math.log(rangeLowUsd / currentPriceUsd) / denom;

  const probability = normalCdf(dHigh) - normalCdf(dLow);
  return Math.max(0, Math.min(100, probability * 100));
}

/** Inverse of normalCdf via bisection rather than a second rational
 *  approximation — guarantees this is exactly consistent with normalCdf
 *  (normalCdf(normalQuantile(p)) === p to bisection precision) instead of
 *  two independently-fitted approximations silently disagreeing. Cheap:
 *  ~60 iterations of pure arithmetic, called at most once per LP-range
 *  request. */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -10;
  let hi = 10;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface InRangeBounds {
  lowUsd: number;
  highUsd: number;
  sigma: number;
}

/**
 * Inverse of computeInRangeProbabilityPct: given a target coverage
 * probability and holding period, returns the symmetric (in log-price)
 * price band a zero-drift lognormal model expects the price to stay
 * within. Same simplifying assumptions as computeInRangeProbabilityPct
 * (zero drift, point-in-time not first-passage) — this is a sizing tool
 * for picking a range, not a guarantee the price never exits it
 * intraperiod.
 */
export function computeInRangeBounds(
  samples: PriceSample[],
  currentPriceUsd: number,
  horizonDays: number,
  targetProbabilityPct: number,
): InRangeBounds | null {
  if (currentPriceUsd <= 0 || horizonDays <= 0 || targetProbabilityPct <= 0 || targetProbabilityPct >= 100) return null;

  const sigma = computeAnnualizedVol(samples);
  if (sigma == null || sigma <= 0) return null;

  const T = horizonDays / 365;
  // Two-sided coverage: target 70% in the middle means 15% cut off each
  // tail, i.e. the quantile at (1 + 0.70) / 2 = 0.85.
  const z = normalQuantile(0.5 + targetProbabilityPct / 200);
  const halfWidth = z * sigma * Math.sqrt(T);

  return {
    lowUsd: currentPriceUsd * Math.exp(-halfWidth),
    highUsd: currentPriceUsd * Math.exp(halfWidth),
    sigma,
  };
}
