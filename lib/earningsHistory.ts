import { redis } from './redis';
import { STOCKS } from './tokens';
import { fetchNasdaqEarningsForDate } from './earningsCalendar';

// Historical earnings-day price moves — genuinely separate from
// lib/earningsCalendar.ts's nextEarnings key, which only ever holds the
// single upcoming date (self-expiring, overwritten as time passes). This
// module accumulates a real history instead: each entry is one already-
// happened report, kept indefinitely (no TTL) so the sample grows quarter
// over quarter.

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

export interface EarningsMove {
  dateStr: string;
  movePct: number;
}

function entryKey(symbol: string): string {
  return `earningsMoves:${symbol}`;
}

export async function recordEarningsMove(symbol: string, dateStr: string, movePct: number): Promise<void> {
  if (!redis) return;
  const score = Number(dateStr.replaceAll('-', ''));
  if (!Number.isFinite(score)) return;
  try {
    await redis.zadd(entryKey(symbol), { score, member: `${dateStr}:${movePct.toFixed(4)}` });
  } catch {
    // best-effort — a dropped write just means this one report is missing until re-backfilled
  }
}

export async function hasEarningsMove(symbol: string, dateStr: string): Promise<boolean> {
  if (!redis) return false;
  try {
    const score = Number(dateStr.replaceAll('-', ''));
    const existing = await redis.zrange<string[]>(entryKey(symbol), score, score, { byScore: true });
    return existing.length > 0;
  } catch {
    return false;
  }
}

export async function getEarningsMoves(symbol: string): Promise<EarningsMove[]> {
  if (!redis) return [];
  try {
    const raw = await redis.zrange<string[]>(entryKey(symbol), 0, -1);
    return raw
      .map((entry) => {
        const idx = entry.indexOf(':');
        if (idx < 0) return null;
        const dateStr = entry.slice(0, idx);
        const movePct = Number(entry.slice(idx + 1));
        return Number.isFinite(movePct) ? { dateStr, movePct } : null;
      })
      .filter((m): m is EarningsMove => m !== null);
  } catch {
    return [];
  }
}

export interface EarningsMoveStats {
  count: number;
  meanAbsMovePct: number;
  moves: EarningsMove[];
}

export async function getEarningsMoveStats(symbol: string): Promise<EarningsMoveStats | null> {
  const moves = await getEarningsMoves(symbol);
  if (moves.length === 0) return null;
  const meanAbsMovePct = moves.reduce((sum, m) => sum + Math.abs(m.movePct), 0) / moves.length;
  return { count: moves.length, meanAbsMovePct, moves };
}

interface YahooClose {
  dateStr: string;
  close: number;
}

async function fetchYahooCloses(ticker: string, period1Sec: number, period2Sec: number): Promise<YahooClose[]> {
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${ticker}?interval=1d&period1=${period1Sec}&period2=${period2Sec}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfterbookEarningsHistory/1.0)' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const timestamps: number[] | undefined = result?.timestamp;
      const closes: (number | null)[] | undefined = result?.indicators?.quote?.[0]?.close;
      if (!timestamps || !closes) continue;
      return timestamps
        .map((ts, i) => ({ dateStr: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] }))
        .filter((c): c is YahooClose => typeof c.close === 'number');
    } catch {
      // try the next host
    }
  }
  return [];
}

/**
 * % price change from the last close *before* earningsDateStr to the
 * first close on or after earningsDateStr + 1 day — spans both the
 * before-market and after-market announcement cases (Nasdaq's own `time`
 * field is inconsistently populated, so this doesn't try to pick a single
 * exact side), at the cost of occasionally including an extra day of
 * ordinary drift. A documented approximation, not exact attribution.
 */
export async function computeHistoricalMove(cashTicker: string, earningsDateStr: string): Promise<number | null> {
  const earningsMs = new Date(`${earningsDateStr}T12:00:00Z`).getTime();
  if (!Number.isFinite(earningsMs)) return null;

  const period1Sec = Math.floor(earningsMs / 1000) - 10 * 86_400;
  const period2Sec = Math.floor(earningsMs / 1000) + 10 * 86_400;
  const closes = await fetchYahooCloses(cashTicker, period1Sec, period2Sec);
  if (closes.length < 2) return null;

  const before = [...closes].reverse().find((c) => c.dateStr < earningsDateStr);
  const dayAfterStr = new Date(earningsMs + 86_400_000).toISOString().slice(0, 10);
  const after = closes.find((c) => c.dateStr >= dayAfterStr);
  if (!before || !after || before.close <= 0) return null;

  return ((after.close - before.close) / before.close) * 100;
}

/**
 * Scans one already-passed calendar day for any of our ten tickers
 * reporting, and records the move for any that aren't already stored.
 * Called with a few days' lag (not "yesterday") by the daily cron so
 * Yahoo's closing prices have settled — see app/api/cron/earnings-sync.
 * Also the building block backfillEarningsHistory calls in a loop for
 * the one-time historical seed.
 */
export async function syncEarningsMovesForDate(dateStr: string): Promise<number> {
  const reporting = await fetchNasdaqEarningsForDate(dateStr);
  if (reporting.size === 0) return 0;

  let recorded = 0;
  for (const stock of STOCKS) {
    if (!reporting.has(stock.cashTicker)) continue;
    if (await hasEarningsMove(stock.symbol, dateStr)) continue;
    const move = await computeHistoricalMove(stock.cashTicker, dateStr);
    if (move != null) {
      await recordEarningsMove(stock.symbol, dateStr, move);
      recorded += 1;
    }
  }
  return recorded;
}

/**
 * One-time historical seed — walks backward lookbackDays from today,
 * day by day (Nasdaq's calendar has no range param), recording any
 * report found for our ten tickers. Meant to be run once to bootstrap
 * real history; the daily cron extension keeps it growing afterward.
 * Intentionally not exposed as an HTTP route — a multi-hundred-day
 * backfill doesn't fit any of this app's existing cron duration budgets,
 * so this is invoked directly (a script, not a request).
 */
export async function backfillEarningsHistory(lookbackDays: number, onProgress?: (dateStr: string, recorded: number) => void): Promise<number> {
  let total = 0;
  const now = Date.now();
  for (let i = 1; i <= lookbackDays; i++) {
    const dateStr = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const recorded = await syncEarningsMovesForDate(dateStr);
    total += recorded;
    onProgress?.(dateStr, recorded);
  }
  return total;
}
