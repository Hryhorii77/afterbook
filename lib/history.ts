import { redis } from './redis';
import { getSessionInfo, nyDateKey, nyOpenInstant, isTradingDay } from './marketClock';

// Basis-since-close history, sampled opportunistically off real traffic
// instead of a cron job — there's no dedicated worker in this app, just
// Vercel functions that only run when someone hits a route. Piggybacking on
// buildTape()'s already-fetched pool state means this costs zero extra RPC
// calls; the tradeoff is gaps during stretches with no visitors at all,
// which is also exactly when nobody's looking at the chart.

const SAMPLE_INTERVAL_MS = 5 * 60_000;
// 30 days — long enough for a meaningful closed-period stat (see
// getClosedPeriodStats below), not just "Friday close -> Monday reopen"
// like the original sparkline needed. Storage impact is trivial: all ten
// symbols at this 5-min throttle is a few tens of thousands of small
// sorted-set entries at most.
const RETENTION_MS = 30 * 24 * 60 * 60_000;

// Module-level: survives across requests on a warm lambda, same pattern as
// lib/tape.ts's cache. Only gates how often we bother writing — losing it on
// a cold start just means the next request writes one redundant sample.
const lastSampleMs = new Map<string, number>();

export interface HistorySample {
  ts: number;
  basisBp: number;
}

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

export interface OpenSnapStats {
  days30: number;
  revertedPct30: number;
  days90: number;
  revertedPct90: number;
}

// How far before 9:30 ET a sample can be and still count as "the pre-open
// basis" — wide because pre-open sampling depends on someone loading the
// page overnight/pre-market, which is sparser traffic than during the day.
const PRE_OPEN_LOOKBACK_MS = 3 * 60 * 60_000;
// How close a sample needs to land to the 30/90-min-after-open mark to
// count for that bucket — tight enough that "shortly after open" means
// what it says, loose enough to survive the opportunistic 5-min sampling.
const POST_OPEN_TOLERANCE_MS = 15 * 60_000;
const MIN_DAYS_FOR_OPEN_SNAP = 8;

function closestBefore(samples: HistorySample[], targetMs: number, maxAgeMs: number): HistorySample | null {
  let best: HistorySample | null = null;
  for (const s of samples) {
    if (s.ts > targetMs || targetMs - s.ts > maxAgeMs) continue;
    if (!best || s.ts > best.ts) best = s;
  }
  return best;
}

function closestNear(samples: HistorySample[], targetMs: number, toleranceMs: number): HistorySample | null {
  let best: HistorySample | null = null;
  let bestDiff = Infinity;
  for (const s of samples) {
    const diff = Math.abs(s.ts - targetMs);
    if (diff > toleranceMs) continue;
    if (diff < bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

/**
 * "At 9:30 ET, basis usually did X" — for each trading day in the window,
 * compares the last sample before that day's 9:30am NY open (the closed-
 * market basis) against samples ~30min and ~90min after, and reports how
 * often |basis| shrank (reverted toward zero) rather than widened or held.
 * Reuses the same opportunistically-sampled history as the sparkline — no
 * new sampling, just a different slice of the same 30-day window.
 */
export async function getOpenSnapStats(symbol: string, sinceMs: number): Promise<OpenSnapStats | null> {
  const samples = await getHistory(symbol, sinceMs);
  if (samples.length === 0) return null;

  const dateKeys = new Set<string>();
  for (const s of samples) {
    const key = nyDateKey(new Date(s.ts));
    const weekday = new Date(`${key}T12:00:00.000Z`).getUTCDay();
    if (isTradingDay(key, weekday)) dateKeys.add(key);
  }

  let days30 = 0;
  let reverted30 = 0;
  let days90 = 0;
  let reverted90 = 0;

  for (const dateKey of dateKeys) {
    const openMs = nyOpenInstant(dateKey).getTime();
    const preOpen = closestBefore(samples, openMs, PRE_OPEN_LOOKBACK_MS);
    if (!preOpen) continue;

    const post30 = closestNear(samples, openMs + 30 * 60_000, POST_OPEN_TOLERANCE_MS);
    if (post30) {
      days30++;
      if (Math.abs(post30.basisBp) < Math.abs(preOpen.basisBp)) reverted30++;
    }

    const post90 = closestNear(samples, openMs + 90 * 60_000, POST_OPEN_TOLERANCE_MS);
    if (post90) {
      days90++;
      if (Math.abs(post90.basisBp) < Math.abs(preOpen.basisBp)) reverted90++;
    }
  }

  if (days30 < MIN_DAYS_FOR_OPEN_SNAP && days90 < MIN_DAYS_FOR_OPEN_SNAP) return null;

  return {
    days30,
    revertedPct30: days30 > 0 ? (reverted30 / days30) * 100 : 0,
    days90,
    revertedPct90: days90 > 0 ? (reverted90 / days90) * 100 : 0,
  };
}
