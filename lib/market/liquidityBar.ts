import 'server-only';
import { unstable_cache } from 'next/cache';
import { redis } from '../server/redis';
import { STOCKS } from '../stocks/tokens';
import { DEPTH_SLOT_MS, getDepthSamplesFor, type DepthSample } from './depthSamples';
import { LIQUID_BAR_USD, type LiquidBarRow } from './liquidLabel';

// The "Liquid" label (owner, 2026-11-19): a stock counts as liquid when its pool's depth has not dropped below
// $100k at any point in the last 72 hours. One read can catch liquidity a bot is moving in and out (LLYc, MRVLc,
// AVGOc, HIMSc read ~$230k but fall to ~$10–20k), and the ~$51k pools seeded on 2026-10-27 sit right at a $50k
// line, so $100k over 72 hours separates real pools from both.
//
// DISPLAY ONLY for now: /stocks and /memes show it. It does not change `isLiquid` (lib/market/liquidity.ts, the $1M
// line), which the Basis Tilt weights use; switching the basket waits for the weighting replay and the owner's OK.
//
// Data: the 5-minute alerts cron's depth samples (lib/market/depthSamples.ts, one key per run, kept 73 hours). The
// daily discover-tokens cron computes each tracked stock's 72-hour low and saves it (`liquidbar:latest`); pages read
// that, cached an hour.

export { LIQUID_BAR_USD } from './liquidLabel';
export type { LiquidStatus, LiquidBarRow } from './liquidLabel';
export const LIQUID_BAR_WINDOW_MS = 72 * 3_600_000;
/** At least this share of the window's 5-minute slots must hold a good read for the stock, or it is "measuring". */
export const MIN_COVERAGE = 0.8;
/** Lone $0 readings dropped as node glitches, at most this many per window. */
export const MAX_ZERO_GLITCHES = 2;
/** A saved bar older than this isn't shown (the daily cron stopped or failed). */
export const STALE_AFTER_MS = 48 * 3_600_000;
const KEY = 'liquidbar:latest';

export interface LiquidBar {
  at: number;
  rows: Record<string, LiquidBarRow>;
}

/** Pure: one stock's status over the window ending at `now`. */
export function liquidBarRow(samples: DepthSample[], symbol: string, now: number): LiquidBarRow {
  const good = samples
    .filter((s) => s.ts <= now && now - s.ts <= LIQUID_BAR_WINDOW_MS)
    .flatMap((s) => {
      const v = s.d?.[symbol];
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? [{ ts: s.ts, usd: v }] : [];
    })
    .sort((a, b) => a.ts - b.ts)
    // A lone $0 between two good readings at or above the bar, each within two slots, is a node answering 0 for a
    // moment (seen on 2026-11-19), not a pool emptied and refilled within ten minutes: count it as a failed read, or
    // one glitch labels a deep stock thin for days. At most MAX_ZERO_GLITCHES per window are dropped, a $0 at either
    // edge always counts, and pulls to anything above $0 (the bots' $10–20k) always count.
    .filter(
      (() => {
        let dropped = 0;
        return (s: { ts: number; usd: number }, i: number, arr: { ts: number; usd: number }[]) => {
          if (s.usd !== 0 || dropped >= MAX_ZERO_GLITCHES) return true;
          const prev = arr[i - 1];
          const next = arr[i + 1];
          // Both neighbours must be good readings at or above the bar and close by: a $0 at the newest reading is
          // not excused (a pool emptied just before the daily compute must not read "Liquid" for a day).
          const prevOk = !!prev && prev.usd >= LIQUID_BAR_USD && s.ts - prev.ts <= 2 * DEPTH_SLOT_MS;
          const nextOk = !!next && next.usd >= LIQUID_BAR_USD && next.ts - s.ts <= 2 * DEPTH_SLOT_MS;
          if (prevOk && nextOk) {
            dropped++;
            return false;
          }
          return true;
        };
      })(),
    );
  const slots = LIQUID_BAR_WINDOW_MS / DEPTH_SLOT_MS;
  // Coverage counts distinct 5-minute slots, not samples, so a doubled write can't inflate it.
  const coverage = Math.min(1, new Set(good.map((s) => Math.floor(s.ts / DEPTH_SLOT_MS))).size / slots);
  const lowUsd = good.length ? Math.min(...good.map((s) => s.usd)) : null;
  const oldest = good.length ? Math.min(...good.map((s) => s.ts)) : null;
  // The whole window must be covered: reads reaching back (within one hour) to its start, and most slots read.
  const spansWindow = oldest != null && now - oldest >= LIQUID_BAR_WINDOW_MS - 3_600_000;
  if (!spansWindow || coverage < MIN_COVERAGE) {
    // Already under the bar is known even before the window fills: one low read is enough to say "thin".
    return { status: lowUsd != null && lowUsd < LIQUID_BAR_USD ? 'thin' : 'measuring', lowUsd, coverage };
  }
  return { status: lowUsd! >= LIQUID_BAR_USD ? 'liquid' : 'thin', lowUsd, coverage };
}

/** Cron only: computes every tracked stock's row from the stored samples. `save` writes `liquidbar:latest`. */
export async function computeLiquidBar({ now = Date.now(), save = false } = {}): Promise<LiquidBar> {
  const samples = await getDepthSamplesFor(LIQUID_BAR_WINDOW_MS, now);
  const bar: LiquidBar = { at: now, rows: Object.fromEntries(STOCKS.map((s) => [s.symbol, liquidBarRow(samples, s.symbol, now)])) };
  // No samples at all means the read failed (or Redis is down): keep the previous labels up instead of saving
  // "measuring" for every stock.
  if (save && redis && samples.length > 0) await redis.set(KEY, bar);
  return bar;
}

async function readBar(): Promise<LiquidBar | null> {
  if (!redis) return null;
  const v = await redis.get<LiquidBar>(KEY);
  return v && typeof v === 'object' && v.rows && typeof v.at === 'number' ? v : null;
}
const cachedBar = unstable_cache(readBar, ['liquid-bar'], { revalidate: 60 * 60 });

/** For pages: the last saved bar, or null (no label shown) if there is none, it is over 48 hours old, or Redis fails. */
export async function getLiquidBar(now = Date.now()): Promise<LiquidBar | null> {
  try {
    const bar = await cachedBar();
    return bar && now - bar.at <= STALE_AFTER_MS ? bar : null;
  } catch {
    return null;
  }
}
