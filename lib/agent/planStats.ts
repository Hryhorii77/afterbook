// Anonymous counts of trade plans made (owner, 2026-11-08: traction for the Stocks Maxxing entry). Per
// UTC day, one Redis hash: plans made, plans Claude explained, plans with at least one buy that passed.
// Nothing about the person is stored: no IP, no wallet (a plan needs no wallet), no input. Trades signed
// from a plan are counted by the swap log instead (source 'plan', lib/swap/swapLog.ts), which reads each
// one back from the chain and keeps wallets only as a short hash.
import { redis } from '../server/redis';

const KEY = (day: string) => `stats:plans:${day}`;
const TTL_S = 400 * 24 * 60 * 60;

export interface PlanDay {
  made: number;
  claude: number;
  withBuy: number;
}

/** Bookkeeping: never throws. One to three Redis commands per plan, plus the expiry once a day (on the
 *  day's first plan). The route waits at most a moment for it (countPlanBriefly). */
export async function countPlan(p: { explainedBy: 'claude' | 'fixed'; buys: number }, now = Date.now()): Promise<void> {
  if (!redis) return;
  const key = KEY(new Date(now).toISOString().slice(0, 10));
  try {
    const pipe = redis.pipeline();
    pipe.hincrby(key, 'made', 1);
    if (p.explainedBy === 'claude') pipe.hincrby(key, 'claude', 1);
    if (p.buys > 0) pipe.hincrby(key, 'withBuy', 1);
    const [made] = (await pipe.exec()) as number[];
    if (made === 1) await redis.expire(key, TTL_S);
  } catch (err) {
    console.error('plan stats: could not count', err instanceof Error ? err.message : err);
  }
}

export async function planStats(days: number, now = Date.now()): Promise<{ days: number; total: PlanDay; byDay: Record<string, PlanDay> } | null> {
  if (!redis) return null;
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  const pipe = redis.pipeline();
  for (const d of dayKeys) pipe.hgetall(KEY(d));
  const rows = (await pipe.exec()) as (Record<string, string | number> | null)[];
  const total: PlanDay = { made: 0, claude: 0, withBuy: 0 };
  const byDay: Record<string, PlanDay> = {};
  rows.forEach((r, i) => {
    if (!r) return;
    const day: PlanDay = { made: Number(r.made ?? 0), claude: Number(r.claude ?? 0), withBuy: Number(r.withBuy ?? 0) };
    byDay[dayKeys[i]] = day;
    total.made += day.made;
    total.claude += day.claude;
    total.withBuy += day.withBuy;
  });
  return { days, total, byDay };
}

/** What the plan route calls: the count, but never more than `ms` of waiting. Upstash retries with backoff
 *  when Redis is down, which would otherwise hold the plan for seconds; a count that loses the race may
 *  still land, or be lost, which is fine for a metric. */
export async function countPlanBriefly(p: { explainedBy: 'claude' | 'fixed'; buys: number }, ms = 300): Promise<void> {
  await Promise.race([countPlan(p), new Promise<void>((resolve) => setTimeout(resolve, ms))]);
}
