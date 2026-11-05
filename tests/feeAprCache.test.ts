import { describe, expect, it, vi } from 'vitest';

// Offline: no Redis (so there are no snapshots and the estimate runs), and a fake chain that counts reads.
const calls = vi.hoisted(() => ({ logs: 0, blocks: 0, swaps: true }));
vi.mock('@/lib/server/redis', () => ({ redis: null }));
vi.mock('../lib/server/redis', () => ({ redis: null }));
vi.mock('../lib/market/quote', async (orig) => ({
  ...(await orig<typeof import('../lib/market/quote')>()),
  getClient: () => ({
    getBlockNumber: async () => 100_000n,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      calls.blocks++;
      return { number: blockNumber, timestamp: BigInt(1_800_000_000 + Math.floor(Number(blockNumber) / 5)) };
    },
    getLogs: async () => {
      calls.logs++;
      return calls.swaps ? [{ args: { amount0: 1_000_000_000n, amount1: -5n, liquidity: 10n ** 15n } }] : [];
    },
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'unstakedFee' ? 100_000 : 500),
  }),
}));

import { computeFeeAprWithFallback } from '../lib/lp/feeApr';
import { getStock } from '../lib/stocks/tokens';

describe('fee-APR fallback cache', () => {
  it('reads the chain once for back-to-back and simultaneous requests on one pool', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000 * 1000 + 20_000_000);
    const nv = getStock('NVDAc')!;
    const [a, b] = await Promise.all([
      computeFeeAprWithFallback('NVDAc', nv, 200, 10n ** 18n),
      computeFeeAprWithFallback('NVDAc', nv, 200, 10n ** 18n),
    ]);
    const logsAfterFirst = calls.logs;
    expect(logsAfterFirst).toBeGreaterThan(0);
    expect(a?.estimated).toBe(true);
    expect(b).toEqual(a);

    vi.setSystemTime(Date.now() + 4 * 60_000);
    await computeFeeAprWithFallback('NVDAc', nv, 200, 10n ** 18n);
    expect(calls.logs).toBe(logsAfterFirst); // still cached at 4 minutes

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await computeFeeAprWithFallback('NVDAc', nv, 200, 10n ** 18n);
    expect(calls.logs).toBe(logsAfterFirst * 2); // read again after 5 minutes
    vi.useRealTimers();
  });

  it('keeps a "no swaps" result for one minute only', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000 * 1000 + 30_000_000);
    calls.swaps = false;
    const aapl = getStock('AAPLc')!;
    expect(await computeFeeAprWithFallback('AAPLc', aapl, 200, 10n ** 18n)).toBeNull();
    const before = calls.logs;
    vi.setSystemTime(Date.now() + 30_000);
    await computeFeeAprWithFallback('AAPLc', aapl, 200, 10n ** 18n);
    expect(calls.logs).toBe(before);
    vi.setSystemTime(Date.now() + 40_000);
    await computeFeeAprWithFallback('AAPLc', aapl, 200, 10n ** 18n);
    expect(calls.logs).toBeGreaterThan(before);
    vi.useRealTimers();
  });
});
