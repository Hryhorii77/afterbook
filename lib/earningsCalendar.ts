import { redis } from './redis';

// Yahoo's calendar endpoint (v10/finance/quoteSummary + calendarEvents,
// which historically returned earnings/dividend dates) now 401s without a
// crumb+cookie CSRF handshake this app doesn't have — unlike v8/finance/chart,
// which stayed open. Nasdaq's undocumented calendar endpoint is the
// alternative: no key, no special headers, same "unofficial but open" trust
// shape as the Yahoo chart call in lib/tape.ts already relies on.
const NASDAQ_HOST = 'https://api.nasdaq.com';

interface NasdaqEarningsRow {
  symbol: string;
}

/** Never throws — a failed day's fetch just means that day contributes no
 *  tickers to the scan, same as a market holiday with no data at all. */
export async function fetchNasdaqEarningsForDate(dateStr: string): Promise<Set<string>> {
  try {
    const res = await fetch(`${NASDAQ_HOST}/api/calendar/earnings?date=${dateStr}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfterbookCalendar/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return new Set();
    const json = await res.json();
    const rows = json?.data?.rows as NasdaqEarningsRow[] | null;
    if (!rows) return new Set();
    return new Set(rows.map((r) => r.symbol).filter((s): s is string => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

/** TTL is sized to the date itself, so a symbol's key self-expires shortly
 *  after its earnings date passes — no separate cleanup pass needed even if
 *  the cron misses a day or a company reschedules. */
export async function recordNextEarnings(symbol: string, isoDate: string | null, now: number): Promise<void> {
  if (!redis) return;
  const key = `nextEarnings:${symbol}`;
  try {
    if (isoDate == null) {
      await redis.del(key);
      return;
    }
    const target = new Date(`${isoDate}T23:59:59Z`).getTime();
    const ttlSeconds = Math.max(60, Math.ceil((target - now) / 1000) + 86_400);
    await redis.set(key, isoDate, { ex: ttlSeconds });
  } catch {
    // best-effort — a missed write just leaves the prior (or no) date cached
  }
}

export async function getNextEarnings(symbol: string): Promise<string | null> {
  if (!redis) return null;
  try {
    return await redis.get<string>(`nextEarnings:${symbol}`);
  } catch {
    return null;
  }
}
