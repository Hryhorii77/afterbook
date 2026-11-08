import { redis } from '../server/redis';

// Yahoo's calendar endpoint (v10/finance/quoteSummary + calendarEvents,
// which historically returned earnings/dividend dates) now 401s without a
// crumb+cookie CSRF handshake this app doesn't have — unlike v8/finance/chart,
// which stayed open. Nasdaq's undocumented calendar endpoint is the
// alternative: no key, no special headers, same "unofficial but open" trust
// shape as the Yahoo chart call in lib/market/tape.ts already relies on.
const NASDAQ_HOST = 'https://api.nasdaq.com';

interface NasdaqEarningsRow {
  symbol: string;
}

/** The tickers reporting on `dateStr`, an empty set for a day with none, or null when the fetch failed.
 *  Never throws. The two must stay apart (2026-11-08, from a review): a failed day used to read as "no
 *  earnings", which deleted saved dates and let the trade plan's earnings wait pass. Nasdaq answers a
 *  day with no reports (a Sunday) with status 200, `data` present and `rows: null`; anything else that
 *  isn't a list of rows is a failure. */
export async function fetchNasdaqEarningsForDate(dateStr: string, fetchFn: typeof fetch = fetch): Promise<Set<string> | null> {
  try {
    const res = await fetchFn(`${NASDAQ_HOST}/api/calendar/earnings?date=${dateStr}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfterbookCalendar/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || typeof json !== 'object' || !json.data || typeof json.data !== 'object') return null;
    if (json.status?.rCode != null && json.status.rCode !== 200) return null;
    const rows = json.data.rows as NasdaqEarningsRow[] | null | undefined;
    if (rows === null) return new Set();
    if (!Array.isArray(rows)) return null;
    return new Set(rows.map((r) => r?.symbol).filter((s): s is string => typeof s === 'string'));
  } catch {
    return null;
  }
}

/** When the earnings job last scanned every day of its window without a failure. */
export const EARNINGS_SYNCED_KEY = 'earnings:syncedAt';

export async function recordEarningsSynced(now: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(EARNINGS_SYNCED_KEY, now, { ex: 30 * 86_400 });
  } catch {
    // best-effort: a missed write makes the trade plan say it couldn't confirm the calendar
  }
}

// Read by the trade plan route only (one per plan, not per tape build), and cached a few minutes anyway.
let syncedCache: { value: number | null; at: number } | null = null;
export async function getEarningsSyncedAt(now = Date.now()): Promise<number | null> {
  if (!redis) return null;
  if (syncedCache && now - syncedCache.at < 5 * 60_000) return syncedCache.value;
  try {
    const raw = await redis.get<number | string>(EARNINGS_SYNCED_KEY);
    const value = raw == null ? null : Number(raw);
    syncedCache = { value: Number.isFinite(value) ? value : null, at: now };
  } catch {
    syncedCache = { value: syncedCache?.value ?? null, at: now };
  }
  return syncedCache.value;
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

// The date only changes when the daily earnings-sync cron runs, but every tape build (every 20 s while
// anyone has the site open, on every warm instance) asked Redis for it: the biggest share of the Redis
// requests that hit the Upstash cap on 2026-10-18. Kept in memory for an hour instead.
const EARNINGS_CACHE_MS = 60 * 60_000;
const earningsCache = new Map<string, { value: string | null; at: number }>();

export async function getNextEarnings(symbol: string): Promise<string | null> {
  if (!redis) return null;
  const hit = earningsCache.get(symbol);
  if (hit && Date.now() - hit.at < EARNINGS_CACHE_MS) return hit.value;
  try {
    const value = await redis.get<string>(`nextEarnings:${symbol}`);
    earningsCache.set(symbol, { value, at: Date.now() });
    return value;
  } catch {
    // Keep the last value (or none) for a few minutes so an outage isn't retried on every build.
    const value = hit?.value ?? null;
    earningsCache.set(symbol, { value, at: Date.now() - EARNINGS_CACHE_MS + 5 * 60_000 });
    return value;
  }
}

/** Days the earnings job scans ahead. One more than the trade plan's longest earnings wait
 *  (PLAN_LIMITS.maxEarningsDays, 14), so the window still covers 14 days when the plan reads it up to a
 *  day after the job ran. */
export const EARNINGS_SCAN_DAYS = 15;

/** Walks the calendar day by day (Nasdaq has no range query) and records, per ticker, the earliest day
 *  it reports in the window. `failedDays` counts days whose fetch failed: with any, a ticker's absence
 *  proves nothing. */
export async function scanNextEarnings(
  tickers: string[],
  now: number,
  fetchDay: (dateStr: string) => Promise<Set<string> | null> = (d) => fetchNasdaqEarningsForDate(d),
  days = EARNINGS_SCAN_DAYS,
): Promise<{ next: Map<string, string>; failedDays: string[] }> {
  const next = new Map<string, string>();
  const failedDays: string[] = [];
  for (let i = 0; i < days; i++) {
    const dateStr = new Date(now + i * 86_400_000).toISOString().slice(0, 10);
    const reporting = await fetchDay(dateStr);
    if (!reporting) {
      failedDays.push(dateStr);
      continue;
    }
    for (const ticker of tickers) if (!next.has(ticker) && reporting.has(ticker)) next.set(ticker, dateStr);
  }
  return { next, failedDays };
}
