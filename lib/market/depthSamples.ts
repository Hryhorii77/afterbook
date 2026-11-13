import { redis } from '../server/redis';
import type { TapeRow } from './tape';

// Pool depth over the last few hours, for ranking pools that must stay deep, not just read deep once
// (the trade plan's "Describe a basket", lib/agent/brief.ts). One read can catch liquidity that keeps
// leaving: on 2026-10-19 a bot moved ~$200k in and out of the LLYc pool and a single read said $254k
// for a pool holding $49k (lib/stocks/discovery.ts, lowestRecentDepthUsd, which walks pool logs and is
// too slow for a page request).
//
// The 5-minute alerts cron writes every stock's depth from the tape it already reads, as ONE key per
// run (`depth:<5-minute slot>`, expiring after 4 hours): about 8,640 writes a month however many stocks
// are tracked (one key per pool would be ~330k; Redis budget, CLAUDE.md). A failed read is stored as
// null, a missing sample, never as $0, which would push a stock under the line for hours.

export const DEPTH_SLOT_MS = 5 * 60_000;
/** How far back "steady" looks. */
export const STEADY_WINDOW_MS = 3 * 3_600_000;
/** A stock with no good sample this recent has an unknown depth (cron down, or just deployed). */
export const DEPTH_FRESH_MS = 15 * 60_000;
const TTL_S = 4 * 3600;

export interface DepthSample {
  ts: number;
  /** Depth in USD per symbol; null = the read failed. */
  d: Record<string, number | null>;
}

export interface SteadyDepth {
  /** The lowest depth over the window's good samples and the live read; null = unknown. */
  usd: number | null;
  /** The newest good sample's time; null when unknown. */
  asOfMs: number | null;
  /** How many good samples went into it. */
  samples: number;
}

const slotOf = (ms: number) => Math.floor(ms / DEPTH_SLOT_MS);
const keyOf = (slot: number) => `depth:${slot}`;

/** Pure: one sample from a tape. Non-finite or negative depths count as failed reads. */
export function sampleFromRows(rows: Pick<TapeRow, 'symbol' | 'depthUsd'>[], ts: number): DepthSample {
  const d: Record<string, number | null> = {};
  for (const r of rows) d[r.symbol] = r.depthUsd != null && Number.isFinite(r.depthUsd) && r.depthUsd >= 0 ? Math.round(r.depthUsd) : null;
  return { ts, d };
}

/**
 * Pure: a stock's steady depth. Unknown when no good sample is newer than DEPTH_FRESH_MS, so a cold
 * start or a stopped cron leaves the stock out rather than falling back to one live read (which would
 * bring the flicker back). `liveUsd`, a fresh read, can only lower the result.
 */
export function steadyDepth(samples: DepthSample[], symbol: string, now: number, liveUsd: number | null = null): SteadyDepth {
  const good = samples
    .filter((s) => s.ts <= now && now - s.ts <= STEADY_WINDOW_MS)
    .flatMap((s) => {
      const v = s.d?.[symbol];
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? [{ ts: s.ts, usd: v }] : [];
    });
  const newest = good.reduce<number | null>((m, s) => (m == null || s.ts > m ? s.ts : m), null);
  if (newest == null || now - newest > DEPTH_FRESH_MS) return { usd: null, asOfMs: null, samples: good.length };
  let lowest = Math.min(...good.map((s) => s.usd));
  if (liveUsd != null && Number.isFinite(liveUsd) && liveUsd >= 0) lowest = Math.min(lowest, liveUsd);
  return { usd: lowest, asOfMs: newest, samples: good.length };
}

/** Called by the alerts cron only. Best effort: a dropped sample is a gap, never a failed cron. */
export async function recordDepthSample(rows: Pick<TapeRow, 'symbol' | 'depthUsd'>[], now = Date.now()): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(keyOf(slotOf(now)), sampleFromRows(rows, now), { ex: TTL_S });
  } catch {
    // a missing sample only shortens the window
  }
}

// One MGET per warm instance per minute at most, and only when someone asks for a brief.
let cache: { at: number; samples: DepthSample[] } | null = null;
const CACHE_MS = 60_000;

export async function getRecentDepthSamples(now = Date.now()): Promise<DepthSample[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.samples;
  if (!redis) return [];
  const last = slotOf(now);
  const keys = Array.from({ length: STEADY_WINDOW_MS / DEPTH_SLOT_MS + 1 }, (_, i) => keyOf(last - i));
  try {
    const raw = await redis.mget<(DepthSample | null)[]>(...keys);
    const samples = raw.filter((s): s is DepthSample => !!s && typeof s.ts === 'number' && !!s.d && typeof s.d === 'object');
    cache = { at: now, samples };
    return samples;
  } catch {
    return []; // every depth unknown: the brief says so rather than guessing
  }
}
