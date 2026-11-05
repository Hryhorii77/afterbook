import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import { blockAtOrBefore, blockRanges } from '../lib/market/blocks';

// A fake chain: 2 s blocks up to SWITCH, then 200 ms blocks (five per whole second), like Denim.
const GENESIS = 1_700_000_000;
const SWITCH = 1_000_000n;
const HEAD = SWITCH + 500_000n;
const timeOf = (n: bigint) => (n <= SWITCH ? GENESIS + Number(n) * 2 : GENESIS + Number(SWITCH) * 2 + Math.floor(Number(n - SWITCH) / 5));
const fake = (reads: { n: number }) =>
  ({
    getBlockNumber: async () => HEAD,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      reads.n++;
      if (blockNumber < 0n || blockNumber > HEAD) throw new Error('no such block');
      return { number: blockNumber, timestamp: BigInt(timeOf(blockNumber)) };
    },
  }) as unknown as PublicClient;

const expectNewestAtOrBefore = (b: bigint, t: number) => {
  expect(timeOf(b)).toBeLessThanOrEqual(t);
  expect(timeOf(b + 1n)).toBeGreaterThan(t);
};

describe('blockAtOrBefore', () => {
  const headT = timeOf(HEAD);
  it.each([
    ['an hour ago (all 200 ms blocks)', headT - 3600],
    ['three hours ago', headT - 3 * 3600],
    ['a day ago (before the switch)', headT - 24 * 3600],
    ['just before the switch', timeOf(SWITCH) - 1],
    ['the switch second itself', timeOf(SWITCH)],
  ])('finds the newest block at or before %s', async (_name, t) => {
    const reads = { n: 0 };
    const b = await blockAtOrBefore(fake(reads), t);
    expectNewestAtOrBefore(b, t);
    expect(reads.n).toBeLessThan(40);
  });

  it('returns the head for a time after it', async () => {
    expect(await blockAtOrBefore(fake({ n: 0 }), timeOf(HEAD) + 10)).toBe(HEAD);
  });
});

describe('blockRanges', () => {
  it('covers the range in inclusive chunks with no gap or overlap', () => {
    const r = blockRanges(100n, 4100n, 2000n);
    expect(r).toEqual([
      { fromBlock: 100n, toBlock: 2099n },
      { fromBlock: 2100n, toBlock: 4099n },
      { fromBlock: 4100n, toBlock: 4100n },
    ]);
  });
});
