import { redis } from './redis';

export type ClickVenue = 'aerodrome-swap' | 'aerodrome-deposit';

export interface ClickRecord {
  symbol: string;
  /** USDC size shown in Lot Lab at click time, if any was entered. */
  usdIn: number | null;
  venue: ClickVenue;
  direction?: 'buy' | 'sell';
  /** From the server-side geo check (x-vercel-ip-country), never trusted
   *  from the client — this log exists to prove real, geo-gated flow to a
   *  future partner, so the one field that matters most has to come from
   *  the request, not from whatever the browser claims. */
  country: string | null;
  ts: number;
}

const LOG_KEY = 'clicks:log';
const MAX_LOG_ENTRIES = 10_000;

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Best-effort, matches lib/alerts.ts's pattern: a dropped write here just
 *  means this one click is missing from the log, never something worth
 *  failing the outbound link over. */
export async function logClick(record: ClickRecord): Promise<void> {
  if (!redis) return;
  try {
    const day = dayKey(record.ts);
    await Promise.all([
      redis.lpush(LOG_KEY, record),
      redis.ltrim(LOG_KEY, 0, MAX_LOG_ENTRIES - 1),
      redis.hincrby(`clicks:daily:${day}`, 'count', 1),
      redis.hincrby(`clicks:daily:${day}`, `symbol:${record.symbol}`, 1),
      record.usdIn ? redis.hincrbyfloat(`clicks:daily:${day}`, 'usdIn', record.usdIn) : Promise.resolve(),
    ]);
  } catch {
    // best-effort — see comment above
  }
}

/** Most recent clicks, newest first — enough to eyeball for a partner pitch
 *  without needing a real analytics stack yet. */
export async function getRecentClicks(limit = 500): Promise<ClickRecord[]> {
  if (!redis) return [];
  try {
    const raw = await redis.lrange<ClickRecord>(LOG_KEY, 0, limit - 1);
    return raw ?? [];
  } catch {
    return [];
  }
}

export async function getDailyClickStats(day: string): Promise<Record<string, string> | null> {
  if (!redis) return null;
  try {
    const raw = await redis.hgetall<Record<string, string>>(`clicks:daily:${day}`);
    return raw ?? null;
  } catch {
    return null;
  }
}
