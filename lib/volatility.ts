import { redis } from './redis';

// Price history for in-range-probability estimates — a genuinely separate
// stream from lib/history.ts's basisBp samples (not an extension of that
// sorted set's member format, which would mix old/new shapes across its
// existing 30-day retention window). Piggybacks on the same real-traffic
// sampling pattern: only written opportunistically from buildTape(), only
// for liquid symbols, throttled the same way.

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MIN_SAMPLES = 20;

/** LPs plan in week-ish increments, and a 7-day horizon keeps the realized-
 *  vol estimate from a 30-day sample window reasonably relevant to it.
 *  Exported so the UI never hardcodes a number that could drift from what's
 *  actually computed. */
export const IN_RANGE_HORIZON_DAYS = 7;

const lastSampleMs = new Map<string, number>();

export interface PriceSample {
  ts: number;
  priceUsd: number;
}

export async function recordPriceSample(symbol: string, priceUsd: number | null, now: number): Promise<void> {
  if (!redis || priceUsd == null || priceUsd <= 0) return;

  const last = lastSampleMs.get(symbol) ?? 0;
  if (now - last < SAMPLE_INTERVAL_MS) return;
  lastSampleMs.set(symbol, now);

  const key = `price:${symbol}`;
  try {
    await Promise.all([
      redis.zadd(key, { score: now, member: `${now}:${priceUsd}` }),
      redis.zremrangebyscore(key, 0, now - RETENTION_MS),
    ]);
  } catch {
    // best-effort — a dropped sample just widens the gap between points
  }
}

export async function getPriceHistory(symbol: string, sinceMs: number): Promise<PriceSample[]> {
  if (!redis) return [];
  try {
    const raw = await redis.zrange<string[]>(`price:${symbol}`, sinceMs, Date.now(), { byScore: true });
    return raw
      .map((entry) => {
        const idx = entry.indexOf(':');
        if (idx < 0) return null;
        const ts = Number(entry.slice(0, idx));
        const priceUsd = Number(entry.slice(idx + 1));
        return Number.isFinite(ts) && Number.isFinite(priceUsd) && priceUsd > 0 ? { ts, priceUsd } : null;
      })
      .filter((s): s is PriceSample => s !== null);
  } catch {
    return [];
  }
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
function computeAnnualizedVol(samples: PriceSample[]): number | null {
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
