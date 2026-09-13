import { Redis } from '@upstash/redis';

// Basis-since-close history, sampled opportunistically off real traffic
// instead of a cron job — there's no dedicated worker in this app, just
// Vercel functions that only run when someone hits a route. Piggybacking on
// buildTape()'s already-fetched pool state means this costs zero extra RPC
// calls; the tradeoff is gaps during stretches with no visitors at all,
// which is also exactly when nobody's looking at the chart.
//
// Works with either the legacy Vercel KV env var names (still what Vercel's
// own Upstash Marketplace integration provisions, for compatibility with the
// old @vercel/kv package) or Upstash's native names, so this doesn't care
// which one the store ends up configured as.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const redis = KV_URL && KV_TOKEN ? new Redis({ url: KV_URL, token: KV_TOKEN }) : null;

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const RETENTION_MS = 4 * 24 * 60 * 60_000; // covers Friday close -> Monday reopen, plus buffer

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
