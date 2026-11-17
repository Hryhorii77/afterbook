import { describe, expect, it, vi, beforeEach } from 'vitest';
import { encodeAbiParameters } from 'viem';
import { classifyAction } from '../lib/stocks/multiplierActions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ unstable_cache: (f: unknown) => f }));
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../lib/server/redis', () => ({
  redis: {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: unknown, opts?: { nx?: boolean }) => {
      if (opts?.nx && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    },
    del: async (k: string) => void store.delete(k),
  },
}));

import { scanRange, mergeActions, syncMultiplierHistory, getMultiplierHistory, HISTORY_START_BLOCK, type ScanDeps } from '../lib/stocks/multiplierHistory';
import { STOCKS } from '../lib/stocks/tokens';

const E18 = BigInt(10) ** BigInt(18);
const AAPL = STOCKS.find((s) => s.symbol === 'AAPLc')!.tokenAddress as `0x${string}`;
const raw = (x: number) => (BigInt(Math.round(x * 1e9)) * BigInt(1e9)).toString();

describe('classifyAction', () => {
  it('reads the AAPLc change of 2026-11-16 as a reinvested dividend', () => {
    const c = classifyAction({ fromRaw: E18.toString(), toRaw: '1000500389301980219' });
    expect(c.kind).toBe('dividend');
    expect(c.pct).toBeCloseTo(0.0500389, 6);
  });
  it('splits, reverse splits and anything else', () => {
    expect(classifyAction({ fromRaw: raw(1.0005), toRaw: raw(4.002) })).toMatchObject({ kind: 'split', ratio: '4-for-1' });
    expect(classifyAction({ fromRaw: raw(1), toRaw: raw(0.1) })).toMatchObject({ kind: 'reverse-split', ratio: '1-for-10' });
    expect(classifyAction({ fromRaw: raw(1), toRaw: raw(1.5) }).kind).toBe('other');
    expect(classifyAction({ fromRaw: raw(1), toRaw: raw(0.97) }).kind).toBe('other');
    expect(classifyAction({ fromRaw: null, toRaw: raw(1.01) })).toMatchObject({ kind: 'other', from: null });
  });
});

/** A fake chain: logs at given blocks; getLogs fails for ranges containing `failAt`. */
function fakeChain(events: { block: bigint; address: `0x${string}`; to: bigint }[], head: bigint, failAt?: bigint) {
  const calls: [bigint, bigint][] = [];
  const deps: ScanDeps = {
    logs: {
      getBlockNumber: async () => head,
      getLogs: (async ({ address, fromBlock, toBlock }: { address: `0x${string}`[]; fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        if (address.length > 10) throw new Error('too many addresses');
        if (failAt != null && failAt >= fromBlock && failAt <= toBlock) throw new Error('rpc');
        const want = new Set(address.map((a) => a.toLowerCase()));
        return events
          .filter((e) => e.block >= fromBlock && e.block <= toBlock && want.has(e.address.toLowerCase()))
          .map((e, i) => ({ address: e.address, blockNumber: e.block, transactionHash: `0x${e.block.toString(16).padStart(64, '0')}`, logIndex: i, data: encodeAbiParameters([{ type: 'uint256' }], [e.to]) }));
      }) as never,
    },
    reads: {
      readContract: (async () => E18) as never,
      getBlock: (async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(1_700_000_000) + blockNumber })) as never,
    },
  };
  return { deps, calls };
}

describe('scanRange', () => {
  it('reads in 50,000-block chunks and decodes each event with the value before it', async () => {
    const start = BigInt(1_000_000);
    const { deps, calls } = fakeChain([{ block: start + BigInt(120_000), address: AAPL, to: BigInt('1000500389301980219') }], BigInt(0));
    const r = await scanRange(deps, [AAPL], start, start + BigInt(149_999));
    expect(calls.map(([a, b]) => Number(b - a + BigInt(1)))).toEqual([50_000, 50_000, 50_000]);
    expect(r.reached).toBe(start + BigInt(149_999));
    expect(r.actions).toEqual([expect.objectContaining({ symbol: 'AAPLc', block: (start + BigInt(120_000)).toString(), fromRaw: E18.toString(), toRaw: '1000500389301980219' })]);
  });
  it('stops at the first chunk that fails, so the cursor never skips a block', async () => {
    const start = BigInt(1_000_000);
    const { deps } = fakeChain([{ block: start + BigInt(160_000), address: AAPL, to: E18 }], BigInt(0), start + BigInt(60_000));
    const r = await scanRange(deps, [AAPL], start, start + BigInt(199_999));
    expect(r.reached).toBe(start + BigInt(49_999));
    expect(r.actions).toEqual([]);
  });
});

describe('the time budget', () => {
  it('stops starting chunks past the deadline and keeps the cursor at what was done', async () => {
    const start = BigInt(1_000_000);
    const { deps } = fakeChain([], BigInt(0));
    const r = await scanRange(deps, [AAPL], start, start + BigInt(999_999), 400, Date.now() - 1);
    expect(r).toMatchObject({ chunks: 0, reached: start - BigInt(1) });
  });
});

describe('mergeActions', () => {
  it('dedupes by transaction and log index, oldest first', () => {
    const a = { symbol: 'AAPLc', block: '20', tx: '0x01', logIndex: 0, atMs: 2, fromRaw: null, toRaw: '1' } as const;
    const b = { ...a, block: '10', tx: '0x02' } as const;
    expect(mergeActions([a], [b, a]).map((x) => x.tx)).toEqual(['0x02', '0x01']);
  });
});

describe('syncMultiplierHistory', () => {
  beforeEach(() => store.clear());
  it('first run scans from the tokens’ launch; the next run only the new blocks', async () => {
    const head = HISTORY_START_BLOCK + BigInt(120_300);
    const ev = { block: HISTORY_START_BLOCK + BigInt(70_000), address: AAPL, to: BigInt('1000500389301980219') };
    const { deps, calls } = fakeChain([ev], head);
    const r1 = await syncMultiplierHistory(deps);
    expect(r1).toMatchObject({ ok: true, caughtUp: true, progressed: true, becameReady: true, found: 1, total: 1 });
    expect(store.has('corp:lock')).toBe(false);
    expect(calls[0][0]).toBe(HISTORY_START_BLOCK);
    expect(store.get('corp:cursor')).toBe((head - BigInt(300)).toString());
    calls.length = 0;
    const { deps: deps2, calls: calls2 } = fakeChain([ev], head + BigInt(1_000));
    const r2 = await syncMultiplierHistory(deps2);
    expect(r2).toMatchObject({ found: 0, total: 1, becameReady: false });
    // One query per 10 addresses for the one new chunk.
    expect(calls2).toEqual(Array(Math.ceil(STOCKS.length / 10)).fill([head - BigInt(299), head + BigInt(700)]));
  });
  it('a token added to STOCKS later gets its past scanned once', async () => {
    store.set('corp:cursor', (HISTORY_START_BLOCK + BigInt(99_999)).toString());
    store.set('corp:scanned', STOCKS.filter((s) => s.symbol !== 'AAPLc').map((s) => s.tokenAddress.toLowerCase()));
    const { deps, calls } = fakeChain([{ block: HISTORY_START_BLOCK + BigInt(5), address: AAPL, to: E18 * BigInt(2) }], HISTORY_START_BLOCK + BigInt(100_300));
    const r = await syncMultiplierHistory(deps);
    expect(r).toMatchObject({ added: 1, found: 1 });
    expect(calls[0]).toEqual([HISTORY_START_BLOCK, HISTORY_START_BLOCK + BigInt(49_999)]);
    expect((store.get('corp:scanned') as string[]).length).toBe(STOCKS.length);
  });
  it('pages stay hidden until the first full scan reaches the head', async () => {
    const head = HISTORY_START_BLOCK + BigInt(1_000_300);
    const { deps } = fakeChain([], head);
    // A run that runs out of time part way: cursor written, history not ready.
    const r = await syncMultiplierHistory(deps, -1);
    expect(r).toMatchObject({ caughtUp: false, progressed: false, becameReady: false });
    expect(store.has('corp:cursor')).toBe(true);
    expect(await getMultiplierHistory()).toEqual({ actions: [], scanned: false });
    const r2 = await syncMultiplierHistory(deps);
    expect(r2).toMatchObject({ caughtUp: true, becameReady: true });
    expect((await getMultiplierHistory()).scanned).toBe(true);
  });
  it('a stuck scan says progressed: false', async () => {
    const head = HISTORY_START_BLOCK + BigInt(100_300);
    const { deps } = fakeChain([], head, HISTORY_START_BLOCK + BigInt(10));
    const r = await syncMultiplierHistory(deps);
    expect(r).toMatchObject({ ok: true, progressed: false, caughtUp: false });
    expect(store.get('corp:cursor')).toBe((HISTORY_START_BLOCK - BigInt(1)).toString());
  });
  it('a second run while one holds the lock returns without reading or writing', async () => {
    store.set('corp:lock', '1');
    const { deps, calls } = fakeChain([], HISTORY_START_BLOCK + BigInt(100_300));
    const r = await syncMultiplierHistory(deps);
    expect(r).toMatchObject({ ok: true, skipped: 'another run is in progress', found: 0 });
    expect(calls).toEqual([]);
    expect(store.has('corp:cursor')).toBe(false);
    expect(store.get('corp:lock')).toBe('1');
  });
});
