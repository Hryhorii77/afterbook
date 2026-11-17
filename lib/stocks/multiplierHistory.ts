// Dividends and splits, read onchain (quest option B, 2026-11-17). A B20 stock token stands for
// multiplier() shares of the real stock; Coinbase reinvests a cash dividend, net of withholding tax and
// a fee, by raising the multiplier, and a split multiplies it. Each change emits
// MultiplierUpdated(uint256 newMultiplier) from the token (AAPLc, 2026-11-16 15:58 UTC, block 58,271,537:
// 1.0 -> 1.000500389, Apple's $0.27 dividend). This module finds those events for every tracked token,
// with the value before (multiplier() one block earlier) and the block time, and keeps them in Redis
// for the stock pages. Only the daily job (/api/cron/corporate-actions) scans, forward from a cursor
// (Coinbase changes a multiplier a few times a quarter; the tape's hourly check still pings the owner).
// Nothing here is inferred from prices: every entry is an onchain event.
import 'server-only';
import { randomUUID } from 'crypto';
import { createPublicClient, decodeAbiParameters, http, parseAbiItem, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { unstable_cache } from 'next/cache';
import { redis } from '../server/redis';
import { getClient } from '../market/quote';
import { STOCKS } from './tokens';
import { classifyAction, type CorporateAction } from './multiplierActions';

export type { CorporateAction } from './multiplierActions';

/**
 * Where the scan starts. The first tracked tokens were deployed at block 49,145,181 (2026-07-26), but
 * publicnode keeps logs only from about block 51,012,378 (2026-09-07). At 51,020,000 all 10 tokens deployed
 * by then read multiplier() exactly 1.0 (checked 2026-11-17), and a dividend or split only moves it from
 * there, so nothing happened before: starting here misses nothing.
 */
export const HISTORY_START_BLOCK = BigInt(51_020_000);
/** publicnode answers eth_getLogs for at most 50,000 blocks and about 10 addresses; mainnet.base.org refuses
 *  it (2026-11-17). Base makes about 5 blocks a second, so a day is about 9 chunks. */
const CHUNK = BigInt(50_000);
const ADDRESSES_PER_QUERY = 10;
/** Blocks left unscanned at the head, so a reorg can't drop an event behind the cursor. */
const CONFIRMATIONS = BigInt(300);
const CONCURRENCY = 2; // chunks at a time, each one query per 10 addresses
const MAX_CHUNKS_PER_RUN = 400;
/** A full scan from the start took about 250 s (2026-11-17); a run stops starting chunks after 75 s, well
 *  inside the cron's 120 s, and the next run carries on from the cursor. A day's new blocks take ~15 s. */
const RUN_BUDGET_MS = 75_000;

const KEY_ACTIONS = 'corp:actions';
const KEY_CURSOR = 'corp:cursor';
const KEY_SCANNED = 'corp:scanned';
/** Set once the first full scan has reached the head: until then the pages show nothing, so a half-done
 *  history never reads as "no dividend so far". */
const KEY_READY = 'corp:ready';
/** One run at a time: two overlapping runs would each write their own list and cursor, and one could drop
 *  the other's find behind its cursor. Expires after the cron's 120 s limit in case a run dies holding it. */
const KEY_LOCK = 'corp:lock';
const LOCK_SECONDS = 130;
/** Deletes the lock only if it still holds this run's value: a run that outlived the lock (only possible
 *  if maxDuration is raised past LOCK_SECONDS) must not free the next run's lock. One atomic step. */
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const EVENT = parseAbiItem('event MultiplierUpdated(uint256 newMultiplier)');
const MULTIPLIER_ABI = [{ type: 'function', name: 'multiplier', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] as const;

let logsClient: PublicClient | null = null;
function getLogsClient(): PublicClient {
  logsClient ??= createPublicClient({ chain: base, transport: http('https://base-rpc.publicnode.com') }) as PublicClient;
  return logsClient;
}

export interface ScanDeps {
  logs: Pick<PublicClient, 'getLogs' | 'getBlockNumber'>;
  reads: Pick<PublicClient, 'readContract' | 'getBlock'>;
}

/** Events for `addresses` in [from, to], in chunks; stops at the first chunk that fails and says how far it got. */
export async function scanRange(
  deps: ScanDeps,
  addresses: `0x${string}`[],
  from: bigint,
  to: bigint,
  maxChunks = MAX_CHUNKS_PER_RUN,
  /** Stop starting new chunks after this time (ms since epoch); the cursor keeps what was done. */
  deadline = Infinity,
): Promise<{ actions: CorporateAction[]; reached: bigint; chunks: number }> {
  const bySymbol = new Map(STOCKS.map((s) => [s.tokenAddress.toLowerCase(), s.symbol]));
  const ranges: [bigint, bigint][] = [];
  for (let a = from; a <= to && ranges.length < maxChunks; a += CHUNK) ranges.push([a, a + CHUNK - BigInt(1) < to ? a + CHUNK - BigInt(1) : to]);
  const results: (Awaited<ReturnType<ScanDeps['logs']['getLogs']>> | null)[] = new Array(ranges.length).fill(null);
  let failedAt = ranges.length;
  for (let i = 0; i < ranges.length && i < failedAt; i += CONCURRENCY) {
    if (Date.now() > deadline) {
      failedAt = i;
      break;
    }
    const batch = ranges.slice(i, i + CONCURRENCY);
    const groups: `0x${string}`[][] = [];
    for (let g = 0; g < addresses.length; g += ADDRESSES_PER_QUERY) groups.push(addresses.slice(g, g + ADDRESSES_PER_QUERY));
    // A chunk counts only if every group's query for it succeeded.
    const got = await Promise.all(
      batch.map(([a, b]) =>
        Promise.all(groups.map((group) => deps.logs.getLogs({ address: group, event: EVENT, fromBlock: a, toBlock: b }))).then(
          (parts) => parts.flat(),
          () => null,
        ),
      ),
    );
    got.forEach((g, j) => {
      results[i + j] = g;
      if (g == null && i + j < failedAt) failedAt = i + j;
    });
  }
  const done = results.slice(0, failedAt) as NonNullable<(typeof results)[number]>[];
  const reached = failedAt === 0 ? from - BigInt(1) : ranges[failedAt - 1][1];
  const actions: CorporateAction[] = [];
  for (const log of done.flat()) {
    const symbol = bySymbol.get(log.address.toLowerCase());
    if (!symbol || log.blockNumber == null || log.transactionHash == null) continue;
    const [toRaw] = decodeAbiParameters([{ type: 'uint256' }], log.data);
    const [fromRaw, block] = await Promise.all([
      deps.reads
        .readContract({ address: log.address, abi: MULTIPLIER_ABI, functionName: 'multiplier', blockNumber: log.blockNumber - BigInt(1) })
        .then((v) => v as bigint)
        .catch(() => null),
      deps.reads.getBlock({ blockNumber: log.blockNumber }),
    ]);
    actions.push({
      symbol,
      block: log.blockNumber.toString(),
      tx: log.transactionHash,
      logIndex: log.logIndex ?? 0,
      atMs: Number(block.timestamp) * 1000,
      fromRaw: fromRaw?.toString() ?? null,
      toRaw: toRaw.toString(),
    });
  }
  return { actions, reached, chunks: done.length };
}

/** Merge new events into the stored list (deduped by transaction and log index), oldest first. */
export function mergeActions(stored: CorporateAction[], found: CorporateAction[]): CorporateAction[] {
  const byId = new Map(stored.map((a) => [`${a.tx}:${a.logIndex}`, a]));
  for (const a of found) byId.set(`${a.tx}:${a.logIndex}`, a);
  return [...byId.values()].sort((x, y) => (BigInt(x.block) < BigInt(y.block) ? -1 : BigInt(x.block) > BigInt(y.block) ? 1 : x.logIndex - y.logIndex));
}

/**
 * Scan forward from the cursor for every tracked token, and from the start up to the cursor for any token
 * added to STOCKS since the last run. A few Redis commands a run. Returns what it did, for the cron's reply.
 */
export async function syncMultiplierHistory(deps: ScanDeps = { logs: getLogsClient(), reads: getClient() }, budgetMs = RUN_BUDGET_MS) {
  if (!redis) return { ok: false as const, error: 'no store' };
  const token = randomUUID();
  const got = await redis.set(KEY_LOCK, token, { nx: true, ex: LOCK_SECONDS });
  if (got == null) return { ok: true as const, skipped: 'another run is in progress' as const, found: 0, becameReady: false };
  try {
    return await syncLocked(deps, budgetMs);
  } finally {
    await redis.eval(RELEASE_LOCK, [KEY_LOCK], [token]).catch(() => {});
  }
}

async function syncLocked(deps: ScanDeps, budgetMs: number) {
  const r = redis!;
  const deadline = Date.now() + budgetMs;
  const [cursorRaw, scannedRaw, storedRaw, readyRaw] = await Promise.all([
    r.get<string | number>(KEY_CURSOR),
    r.get<string[]>(KEY_SCANNED),
    r.get<CorporateAction[]>(KEY_ACTIONS),
    r.get<string | number>(KEY_READY),
  ]);
  const head = (await deps.logs.getBlockNumber()) - CONFIRMATIONS;
  const cursor = cursorRaw != null ? BigInt(cursorRaw) : HISTORY_START_BLOCK - BigInt(1);
  const all = STOCKS.map((s) => s.tokenAddress.toLowerCase() as `0x${string}`);
  const scanned = new Set((scannedRaw ?? []).map((a) => a.toLowerCase()));
  // A token added to STOCKS after the first full scan: the panel is already on, so its page says "No dividend
  // or split … so far" until its past is scanned, normally by the next run (or the one after, if a run runs
  // out of time). Rare and fixes itself; corp:ready deliberately isn't cleared for it.
  const added = cursorRaw != null ? all.filter((a) => !scanned.has(a)) : [];
  const known = all.filter((a) => !added.includes(a));

  let found: CorporateAction[] = [];
  let budget = MAX_CHUNKS_PER_RUN;
  // Tokens new to STOCKS: their past up to the cursor (the forward scan below covers them from there).
  let addedDone = true;
  let addedProgress = false;
  if (added.length) {
    const back = await scanRange(deps, added, HISTORY_START_BLOCK, cursor, budget, deadline);
    found = found.concat(back.actions);
    budget -= back.chunks;
    addedDone = back.reached >= cursor;
    addedProgress = back.chunks > 0;
  }
  const fwd = cursor < head && budget > 0 ? await scanRange(deps, addedDone ? all : known, cursor + BigInt(1), head, budget, deadline) : { actions: [], reached: cursor, chunks: 0 };
  found = found.concat(fwd.actions);

  const stored = storedRaw ?? [];
  const merged = mergeActions(stored, found);
  const caughtUp = fwd.reached >= head && addedDone;
  const becameReady = caughtUp && readyRaw == null;
  // The list first, then the cursor: a run that dies between them rescans, never skips.
  if (merged.length !== stored.length) await r.set(KEY_ACTIONS, merged);
  const writes: Promise<unknown>[] = [r.set(KEY_CURSOR, fwd.reached.toString())];
  if (addedDone) writes.push(r.set(KEY_SCANNED, all));
  if (becameReady) writes.push(r.set(KEY_READY, Date.now()));
  await Promise.all(writes);
  return {
    ok: true as const,
    from: (cursor + BigInt(1)).toString(),
    reached: fwd.reached.toString(),
    head: head.toString(),
    caughtUp,
    // false while not caught up: the first query failed or timed out, so a stuck scan shows in the logs.
    progressed: fwd.reached > cursor || addedProgress || cursor >= head,
    becameReady,
    added: added.length,
    found: found.length,
    total: merged.length,
  };
}

/** Every stored action for the stock pages, and whether the first full scan has finished (`scanned` false:
 *  the pages say nothing rather than "none so far"). Two Redis reads an hour per instance (Next's data
 *  cache); the cron refreshes it when it finds something or first catches up. */
export const getMultiplierHistory = unstable_cache(
  async (): Promise<{ actions: CorporateAction[]; scanned: boolean }> => {
    if (!redis) return { actions: [], scanned: false };
    try {
      const [actions, ready] = await Promise.all([redis.get<CorporateAction[]>(KEY_ACTIONS), redis.get<string | number>(KEY_READY)]);
      return { actions: actions ?? [], scanned: ready != null };
    } catch {
      return { actions: [], scanned: false };
    }
  },
  ['corp-actions-v2'],
  { revalidate: 3600, tags: ['corp-actions'] },
);

export { classifyAction };
