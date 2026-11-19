import { redis } from '../server/redis';
import { fetchCoinbaseStockList, type ListedToken } from './coinbaseStockList';
import { STOCKS } from './tokens';

// A guard against Coinbase's list shrinking under us. On 2026-11-19 it went from 358 tokens to 90, in one page
// with no paging field (all 38 tracked stocks still in it); nothing noticed. Three things read the list and would
// silently follow a broken one: /stocks (rows vanish), the icons (letter tiles), and the meme job (it rules out
// other Coinbase stock tokens, so a stock token missing from the list could be listed as a meme).
//
// Only the daily discover-tokens cron writes the "last good" list (owner, 2026-11-19), so Redis stays off the
// page paths' write side; readers keep it in memory for an hour. A fresh list more than SHRINK_LIMIT smaller than
// the last good one is not trusted: readers use the last good list and the cron alerts the owner. Separately, the
// cron alerts when a tracked stock is missing from the fresh list even though the count holds.

const LAST_GOOD_KEY = 'cblist:lastgood';
/** A fresh list this much smaller than the last good one is treated as broken: readers use the last good one. */
export const SHRINK_LIMIT = 0.25;
/** Any drop of more than this alerts, and no smaller list ever replaces the saved one automatically (owner,
 *  2026-11-19: 20% a day went 95, 76, 60, 48, 38 with every step saved and no alert). */
export const DROP_ALERT = 0.1;
/** A baseline not updated for this many days is reported, once every this many days. */
export const STALE_DAYS = 7;
const MEMORY_MS = 60 * 60_000;

/** What is kept of each token: what the readers use, so the stored list stays small. */
export interface StoredToken {
  symbol: string;
  contract_address: string;
  name: string;
  icon_url: string | null;
}
export interface LastGoodList {
  at: number;
  tokens: StoredToken[];
}

const slim = (t: ListedToken): StoredToken | null =>
  typeof t.symbol === 'string' && typeof t.contract_address === 'string'
    ? { symbol: t.symbol, contract_address: t.contract_address, name: typeof t.name === 'string' ? t.name : '', icon_url: typeof t.icon_url === 'string' ? t.icon_url : null }
    : null;

/** Pure: how a fresh list compares with the last good one and with the tracked stocks. */
export function judgeCoinbaseList(
  fresh: ListedToken[],
  lastGood: LastGoodList | null,
  tracked: { symbol: string; tokenAddress: string }[] = STOCKS,
): { shrunk: boolean; freshCount: number; lastGoodCount: number | null; missingTracked: string[] } {
  // Both sides counted the same way: entries with a string symbol and address (what is stored), so padding the
  // fresh list with junk can't hide a drop in real tokens.
  const valid = fresh.map(slim).filter((t): t is StoredToken => t !== null);
  const addresses = new Set(valid.map((t) => t.contract_address.toLowerCase()));
  const lastGoodCount = lastGood ? lastGood.tokens.map((t) => slim(t as ListedToken)).filter(Boolean).length : null;
  return {
    shrunk: lastGoodCount != null && valid.length < lastGoodCount * (1 - SHRINK_LIMIT),
    freshCount: valid.length,
    lastGoodCount,
    missingTracked: tracked.filter((s) => !addresses.has(s.tokenAddress.toLowerCase())).map((s) => s.symbol),
  };
}

let memory: { at: number; value: LastGoodList | null } | null = null;

export async function readLastGoodList(now = Date.now()): Promise<LastGoodList | null> {
  if (memory && now - memory.at < MEMORY_MS) return memory.value;
  let value: LastGoodList | null = null;
  try {
    const raw = redis ? await redis.get<LastGoodList>(LAST_GOOD_KEY) : null;
    value = raw && Array.isArray(raw.tokens) && raw.tokens.length > 0 ? raw : null;
  } catch {
    value = null; // no baseline: the fresh list is used as before
  }
  memory = { at: now, value };
  return value;
}

/**
 * The list for /stocks, the icons and the meme job: the fresh one, unless it is more than SHRINK_LIMIT smaller
 * than the last good one, in which case the last good one. A failed fetch still throws, as before.
 */
export async function getCoinbaseStockList(init: Parameters<typeof fetchCoinbaseStockList>[0] = {}): Promise<ListedToken[]> {
  const fresh = await fetchCoinbaseStockList(init);
  const lastGood = await readLastGoodList();
  return judgeCoinbaseList(fresh, lastGood).shrunk ? lastGood!.tokens : fresh;
}

/**
 * Cron only. Saves the fresh list as the last good one unless it shrank too far, and says what to alert about.
 * `dry` reads but writes nothing.
 */
export async function checkCoinbaseList(
  fresh: ListedToken[],
  { dry = false, now = Date.now() }: { dry?: boolean; now?: number } = {},
): Promise<{
  saved: boolean;
  alerts: string[];
  shrunk: boolean;
  freshCount: number;
  lastGoodCount: number | null;
  missingTracked: string[];
  /** Whole days since the saved list was written; null when there is none. */
  baselineAgeDays: number | null;
  /** The list the cron's own discovery step should use: the last good one when the fresh one shrank too far. */
  useList: ListedToken[];
}> {
  // The cron reads Redis itself and lets errors throw (the route turns that into a "guard failed" alert and saves
  // nothing): a failed read must never look like "no baseline yet" and quietly accept a collapsed list.
  memory = null;
  let lastGood: LastGoodList | null = null;
  if (redis) {
    const raw = await redis.get<LastGoodList>(LAST_GOOD_KEY);
    if (raw != null) {
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tokens) || raw.tokens.length === 0) {
        throw new Error(`the stored last good list (${LAST_GOOD_KEY}) is unreadable; delete it to start a new baseline`);
      }
      lastGood = raw;
    }
  }
  const j = judgeCoinbaseList(fresh, lastGood);
  const alerts: string[] = [];
  const dropped = j.lastGoodCount != null && j.freshCount < j.lastGoodCount;
  if (!j.shrunk && j.lastGoodCount != null && j.freshCount < j.lastGoodCount * (1 - DROP_ALERT)) {
    alerts.push(
      `Coinbase's tokenized-stock list dropped from ${j.lastGoodCount} to ${j.freshCount} tokens (over ${DROP_ALERT * 100}%, under ${SHRINK_LIMIT * 100}%). ` +
        `It is still used, but not saved as the baseline. If the smaller list is real, delete the Redis key ${LAST_GOOD_KEY} (unless a tracked stock is missing from it).`,
    );
  }
  if (j.shrunk) {
    alerts.push(
      `Coinbase's tokenized-stock list shrank from ${j.lastGoodCount} to ${j.freshCount} tokens (over ${SHRINK_LIMIT * 100}%). ` +
        `/stocks, the icons and the meme job keep using the last good list (from ${new Date(lastGood!.at).toISOString().slice(0, 10)}) until this is checked. ` +
        `If the smaller list is real, delete the Redis key ${LAST_GOOD_KEY} and the next run takes the new list as the baseline (unless a tracked stock is missing from it).`,
    );
  }
  if (j.missingTracked.length > 0) {
    alerts.push(
      `Tracked stocks missing from Coinbase's list: ${j.missingTracked.join(', ')} (list has ${j.freshCount} tokens). ` +
        `They keep their tape rows and pages, but /stocks loses their rows and their icons fall back to letter tiles. ` +
        `The saved baseline is not updated until each is back in Coinbase's list or removed from STOCKS (lib/stocks/tokens.ts); deleting ${LAST_GOOD_KEY} does not change that.`,
    );
  }
  // A baseline that hasn't been updated in a week (a small drop or a missing tracked stock keeps it frozen) says so
  // once a week, so it can't go stale silently.
  const notSaving = j.shrunk || dropped || j.missingTracked.length > 0;
  const ageDays = lastGood ? Math.floor((now - lastGood.at) / 86_400_000) : null;
  if (notSaving && ageDays != null && ageDays >= STALE_DAYS && ageDays % STALE_DAYS === 0) {
    alerts.push(
      `The saved Coinbase list (${LAST_GOOD_KEY}, ${j.lastGoodCount} tokens) is ${ageDays} days old and isn't being updated: today's list has ${j.freshCount}` +
        `${j.missingTracked.length ? ` and is missing ${j.missingTracked.join(', ')}` : ''}. Tokens Coinbase added since then aren't in the fallback.`,
    );
  }
  // Saved only when nothing is wrong: not smaller than the saved list (a slow shrink can't walk the baseline down)
  // and no tracked stock missing (a bad list can't become the fallback).
  let saved = false;
  if (!dry && !j.shrunk && !dropped && j.missingTracked.length === 0 && redis) {
    const tokens = fresh.map(slim).filter((t): t is StoredToken => t !== null);
    if (tokens.length > 0) {
      await redis.set(LAST_GOOD_KEY, { at: now, tokens } satisfies LastGoodList);
      memory = { at: now, value: { at: now, tokens } };
      saved = true;
    }
  }
  return { saved, alerts, ...j, baselineAgeDays: ageDays, useList: j.shrunk ? lastGood!.tokens : fresh };
}

/**
 * For the meme job: every address that is a Coinbase stock token as far as we know, so a list glitch can't let one
 * be listed as a meme. The union of the tracked stocks, the fresh list and the last good list (a token that is new
 * in a shrunk fresh list is still excluded). Throws if the fresh list can't be fetched, as before.
 */
export async function getStockTokenExclusions(init: Parameters<typeof fetchCoinbaseStockList>[0] = {}): Promise<Set<string>> {
  const [fresh, lastGood] = await Promise.all([fetchCoinbaseStockList(init), readLastGoodList()]);
  const out = new Set<string>(STOCKS.map((s) => s.tokenAddress.toLowerCase()));
  for (const t of [...fresh, ...(lastGood?.tokens ?? [])]) {
    if (typeof t.contract_address === 'string') out.add(t.contract_address.toLowerCase());
  }
  return out;
}
