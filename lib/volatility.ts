import { redis } from './redis';
import type { PriceSample } from './volatilityMath';

export * from './volatilityMath';

// Price history for in-range-probability estimates — a genuinely separate
// stream from lib/history.ts's basisBp samples (not an extension of that
// sorted set's member format, which would mix old/new shapes across its
// existing 30-day retention window). Piggybacks on the same real-traffic
// sampling pattern: only written opportunistically from buildTape(), only
// for liquid symbols, throttled the same way.

const SAMPLE_INTERVAL_MS = 5 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

const lastSampleMs = new Map<string, number>();

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
