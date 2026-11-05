import type { PublicClient } from 'viem';

// Block counts stopped being a clock on 2026-11-05: Base's Denim upgrade (18:00 UTC) moved from one
// block every 2 s to one every 200 ms. A window meant as "the last hour" must be found by block
// timestamps, which still count real seconds, not by multiplying hours by a block rate.

/** Shortest block time Base has had (Denim, 200 ms): bounds how far back a search has to look. */
const MIN_BLOCK_SECONDS = 0.2;

/**
 * The newest block whose timestamp is at or before `unixSeconds`. Interpolation search on
 * timestamps (block times are steady on each side of a change, so it usually takes 3-6 block
 * reads), falling back to halving when a guess lands badly. Works across a block-time change.
 */
export async function blockAtOrBefore(client: PublicClient, unixSeconds: number, head?: bigint): Promise<bigint> {
  const time = async (n: bigint) => Number((await client.getBlock({ blockNumber: n })).timestamp);
  let hi = head ?? (await client.getBlockNumber());
  let hiT = await time(hi);
  if (unixSeconds >= hiT) return hi;
  // Blocks are never faster than MIN_BLOCK_SECONDS, so this many blocks back is at or before the target.
  const span = BigInt(Math.ceil((hiT - unixSeconds) / MIN_BLOCK_SECONDS)) + 10n;
  let lo = hi > span ? hi - span : 0n;
  let loT = await time(lo);
  if (loT > unixSeconds) return lo; // the chain is younger than the window
  for (let step = 0; hi - lo > 1n && step < 64; step++) {
    // Guess by straight-line interpolation; every third step (or a guess at the edge) halves instead.
    let mid = hiT > loT && step % 3 !== 2 ? lo + BigInt(Math.floor((Number(hi - lo) * (unixSeconds - loT)) / (hiT - loT))) : (lo + hi) / 2n;
    if (mid <= lo) mid = lo + 1n;
    if (mid >= hi) mid = hi - 1n;
    const t = await time(mid);
    if (t <= unixSeconds) [lo, loT] = [mid, t];
    else [hi, hiT] = [mid, t];
  }
  return lo;
}

/** eth_getLogs range per call: mainnet.base.org caps it at 2,000 blocks (publicnode at 50,000). */
export const LOG_CHUNK_BLOCKS = 2000n;

/** [from, to] split into inclusive ranges of at most `size` blocks, oldest first. */
export function blockRanges(from: bigint, to: bigint, size = LOG_CHUNK_BLOCKS): { fromBlock: bigint; toBlock: bigint }[] {
  const out: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let f = from; f <= to; f += size) out.push({ fromBlock: f, toBlock: f + size - 1n > to ? to : f + size - 1n });
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}
