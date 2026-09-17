import { redis } from './redis';
import { getSessionInfo } from './marketClock';

// Basis-since-close history, sampled opportunistically off real traffic
// instead of a cron job — there's no dedicated worker in this app, just
// Vercel functions that only run when someone hits a route. Piggybacking on
// buildTape()'s already-fetched pool state means this costs zero extra RPC
// calls; the tradeoff is gaps during stretches with no visitors at all,
// which is also exactly when nobody's looking at the chart.

const SAMPLE_INTERVAL_MS = 5 * 60_000;
// 30 days — long enough for a meaningful closed-period stat (see
// getClosedPeriodStats below), not just "Friday close -> Monday reopen"
// like the original sparkline needed. Storage impact is trivial: a
// handful of liquid symbols at this 5-min throttle is a few tens of
// thousands of small sorted-set entries at most.
const RETENTION_MS = 30 * 24 * 60 * 60_000;

// Module-level: survives across requests on a warm lambda, same pattern as
// lib/tape.ts's cache. Only gates how often we bother writing — losing it on
// a cold start just means the next request writes one redundant sample.
const lastSampleMs = new Map<string, number>();

export interface HistorySample {
  ts: number;
  basisBp: number;
}

/** Caller is responsible for only sampling liquid symbols (see isLiquid in
 *  lib/liquidity.ts) — this module doesn't have the depth data to check. */
export async function recordSample(symbol: string, basisBp: number | null, now: number): Promise<void> {
  if (!redis || basisBp == null) return;

  const last = lastSampleMs.get(symbol) ?? 0;
  if (now - last < SAMPLE_INTERVAL_MS) return;
  lastSampleMs.set(symbol, now);

  const key = `hist:${symbol}`;
  try {
    await Promise.all([
      redis.zadd(key, { score: now, member: `${now}:${basisBp.toFixed(2)}` }),
      redis.zremrangebyscore(key, 0, now - RETENTION_MS),
    ]);
  } catch {
    // best-effort — a dropped sample just leaves a gap in the sparkline
  }
}

export async function getHistory(symbol: string, sinceMs: number): Promise<HistorySample[]> {
  if (!redis) return [];
  try {
    const raw = await redis.zrange<string[]>(`hist:${symbol}`, sinceMs, Date.now(), {
      byScore: true,
    });
    return raw
      .map((entry) => {
        const idx = entry.indexOf(':');
        if (idx < 0) return null;
        const ts = Number(entry.slice(0, idx));
        const basisBp = Number(entry.slice(idx + 1));
        return Number.isFinite(ts) && Number.isFinite(basisBp) ? { ts, basisBp } : null;
      })
      .filter((s): s is HistorySample => s !== null);
  } catch {
    return [];
  }
}

export interface ClosedPeriodStats {
  count: number;
  meanBp: number;
  meanAbsBp: number;
  maxAbsBp: number;
}

const MIN_SAMPLES_FOR_STATS = 20;

/**
 * Summarizes how big the basis typically gets while the cash market is
 * NOT open — the product's actual premise (24/7 onchain vs 24/5 cash),
 * not a precise "N hours since close" curve (that would need deriving
 * exact close boundaries per day, which lib/marketClock.ts doesn't
 * expose). getSessionInfo is a pure NYSE-calendar function, so calling
 * it with a past sample's own timestamp correctly classifies what the
 * session state was at that moment, not the current one.
 */
export async function getClosedPeriodStats(symbol: string, sinceMs: number): Promise<ClosedPeriodStats | null> {
  const samples = await getHistory(symbol, sinceMs);
  const closed = samples.filter((s) => getSessionInfo(new Date(s.ts)).state !== 'open');
  if (closed.length < MIN_SAMPLES_FOR_STATS) return null;

  const sum = closed.reduce((acc, s) => acc + s.basisBp, 0);
  const sumAbs = closed.reduce((acc, s) => acc + Math.abs(s.basisBp), 0);
  const maxAbs = closed.reduce((acc, s) => Math.max(acc, Math.abs(s.basisBp)), 0);

  return {
    count: closed.length,
    meanBp: sum / closed.length,
    meanAbsBp: sumAbs / closed.length,
    maxAbsBp: maxAbs,
  };
}
