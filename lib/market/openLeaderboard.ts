// /today's "Who mean-reverts at the open" (2026-11-25): how often each stock's gap moved toward zero within 30 minutes
// of the 9:30 ET open, over 30 days. Computing it reads 30 days of 5-minute history for every tracked stock (~14 s
// cold for 39), and it only changes once a trading day, so the daily discover-tokens cron (13:00 UTC, before the open)
// computes it and saves one key; the page reads that key through the data cache. Without the key (the first day, or
// a failed run) the page computes it itself, as it did before. Display only.
import { redis } from '../server/redis';
import { STOCKS } from '../stocks/tokens';
import { getOpenSnapStats, STATS_LOOKBACK_MS, type OpenSnapStats } from './history';

export interface LeaderboardRow {
  symbol: string;
  stats: OpenSnapStats;
}

export interface SavedLeaderboard {
  at: number;
  rows: LeaderboardRow[];
}

const KEY = 'today:openleaderboard';
/** Three days: a missed daily run or two still leaves one; past that the page computes it. */
const TTL_S = 3 * 24 * 60 * 60;

/** Every tracked stock with enough sessions, most often reverting first. */
export async function computeOpenLeaderboard(now = Date.now()): Promise<LeaderboardRow[]> {
  const since = now - STATS_LOOKBACK_MS;
  const results = await Promise.all(STOCKS.map(async (stock) => ({ symbol: stock.symbol, stats: await getOpenSnapStats(stock.symbol, since).catch(() => null) })));
  return results.filter((r): r is LeaderboardRow => r.stats != null).sort((a, b) => b.stats.revertedPct30 - a.stats.revertedPct30);
}

/** Cron only: computes and saves it (unless `save` is false). Returns how many rows. */
export async function refreshOpenLeaderboard({ save = true, now = Date.now() }: { save?: boolean; now?: number } = {}): Promise<number> {
  const rows = await computeOpenLeaderboard(now);
  // An empty result (history unreadable) never replaces a good saved one.
  if (save && redis && rows.length > 0) await redis.set(KEY, { at: now, rows } satisfies SavedLeaderboard, { ex: TTL_S });
  return rows.length;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Every row the page draws must be whole (review of #243): a string symbol and finite counts, or the page computes
 *  it itself rather than crash on a bad row. */
function isRow(r: unknown): r is LeaderboardRow {
  if (!r || typeof r !== 'object') return false;
  const { symbol, stats } = r as { symbol?: unknown; stats?: Record<string, unknown> };
  return typeof symbol === 'string' && !!stats && typeof stats === 'object' && finite(stats.days30) && finite(stats.revertedPct30);
}

function isSaved(v: unknown): v is SavedLeaderboard {
  if (!v || typeof v !== 'object') return false;
  const { at, rows } = v as { at?: unknown; rows?: unknown };
  return finite(at) && Array.isArray(rows) && rows.every(isRow);
}

/** The saved leaderboard, or null when there is none (or it can't be read). */
export async function readOpenLeaderboard(): Promise<LeaderboardRow[] | null> {
  if (!redis) return null;
  const v = await redis.get<unknown>(KEY).catch(() => null);
  return isSaved(v) && v.rows.length > 0 ? v.rows : null;
}
