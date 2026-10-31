import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/redis', () => ({ redis: null }));
vi.mock('../lib/redis', () => ({ redis: null }));

import { carryOverFailed, MEME_CARRY_MAX_AGE_MS, type MemeAllowlist, type MemePool } from '../lib/memestocks';

const NOW = 10 * MEME_CARRY_MAX_AGE_MS;
const pool = (id: string, stockSymbol: string, extra: Partial<MemePool> = {}): MemePool => ({
  id,
  venue: 'aero',
  stockSymbol,
  meme: { address: '0x0000000000000000000000000000000000000001', symbol: 'M', name: 'M', decimals: 18 },
  verification: 'proven',
  hooks: null,
  createdAt: null,
  verifiedAt: NOW - 1000,
  ...extra,
});

describe('carryOverFailed', () => {
  const previous: MemeAllowlist = { checkedAt: NOW - 1000, pools: [pool('a', 'NVDAc'), pool('b', 'MUc'), pool('c', 'MUc')] };

  it('keeps a failed stock’s previous pools', () => {
    const next: MemeAllowlist = { checkedAt: 2, pools: [pool('d', 'NVDAc')] };
    const out = carryOverFailed(next, previous, ['MUc'], NOW);
    expect(out.pools.map((p) => p.id)).toEqual(['d', 'b', 'c']);
    expect(out.checkedAt).toBe(2);
  });

  it('drops a pool that failed the check on a stock whose lookup worked', () => {
    const next: MemeAllowlist = { checkedAt: 2, pools: [] };
    expect(carryOverFailed(next, previous, ['MUc'], NOW).pools.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('does not duplicate a pool already in the new list', () => {
    const next: MemeAllowlist = { checkedAt: 2, pools: [pool('b', 'MUc')] };
    expect(carryOverFailed(next, previous, ['MUc'], NOW).pools.map((p) => p.id)).toEqual(['b', 'c']);
  });

  it('never carries a non-meme (rETH) or a stablecoin symbol', () => {
    const prev: MemeAllowlist = {
      checkedAt: NOW,
      pools: [
        pool('r', 'TSLAc', { meme: { address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c', symbol: 'rETH', name: 'Rocket Pool ETH', decimals: 18 } }),
        pool('u', 'TSLAc', { meme: { address: '0x0000000000000000000000000000000000000002', symbol: 'fakeUSD', name: 'x', decimals: 18 } }),
        pool('t', 'TSLAc'),
      ],
    };
    expect(carryOverFailed({ checkedAt: NOW, pools: [] }, prev, ['TSLAc'], NOW).pools.map((p) => p.id)).toEqual(['t']);
  });

  it('drops a carried pool whose last proof is over three days old', () => {
    const prev: MemeAllowlist = {
      checkedAt: NOW,
      pools: [pool('old', 'MUc', { verifiedAt: NOW - MEME_CARRY_MAX_AGE_MS - 1 }), pool('legacy', 'MUc', { verifiedAt: undefined })],
    };
    // 'legacy' has no verifiedAt and falls back to the list's checkedAt (recent), so it stays.
    expect(carryOverFailed({ checkedAt: NOW, pools: [] }, prev, ['MUc'], NOW).pools.map((p) => p.id)).toEqual(['legacy']);
  });

  it('is a no-op without failures or a previous list', () => {
    const next: MemeAllowlist = { checkedAt: 2, pools: [] };
    expect(carryOverFailed(next, previous, [], NOW)).toBe(next);
    expect(carryOverFailed(next, null, ['MUc'], NOW)).toBe(next);
  });
});
