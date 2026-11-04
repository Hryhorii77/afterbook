import { describe, expect, it, vi } from 'vitest';

// Offline: Coinbase's list is a fixture, the pool check never reaches the chain, Redis is off and the
// cron runs with ?dry=1, so nothing is sent or stored.
const LIST = vi.hoisted(() => ({ tokens: [] as Record<string, unknown>[] }));
vi.mock('@/lib/server/redis', () => ({ redis: null }));
vi.mock('@/lib/server/sharedSecret', () => ({ cronAuthorized: () => true }));
vi.mock('@/lib/alerts/telegram', () => ({ sendTelegramMessage: vi.fn() }));
vi.mock('@/lib/stocks/stockDirectory', () => ({ saveDirectoryPools: vi.fn() }));
vi.mock('@/lib/stocks/coinbaseStockList', async (orig) => ({
  ...(await orig<typeof import('../lib/stocks/coinbaseStockList')>()),
  fetchCoinbaseStockList: async () => LIST.tokens,
}));
vi.mock('@/lib/stocks/discovery', async (orig) => ({
  ...(await orig<typeof import('../lib/stocks/discovery')>()),
  verifyCandidate: async (symbol: string, tokenAddress: `0x${string}`) => ({ symbol, tokenAddress, depthUsd: null, poolAddress: null, snippet: null, stock: null }),
}));

import { splitListedTokens } from '../lib/stocks/coinbaseStockList';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/cron/discover-tokens/route';

const A = (n: number) => `0xb2${String(n).padStart(38, '0')}`;

describe('splitListedTokens', () => {
  it('keeps normal and share-class symbols, skips the rest with a reason', () => {
    const { kept, skipped } = splitListedTokens([
      { symbol: 'NVDAc', contract_address: A(1) },
      { symbol: 'BRK.Bc', contract_address: A(2) },
      { symbol: 'BF-Bc', contract_address: A(3) },
      { symbol: 'XYZc', contract_address: 'not an address' },
      { symbol: 'NVDAc', contract_address: A(4) },
      { name: 'no symbol', contract_address: A(5) },
    ]);
    expect(kept.map((t) => t.symbol)).toEqual(['NVDAc', 'BRK.Bc']);
    expect(skipped.map((s) => `${s.symbol}: ${s.reason}`)).toEqual([
      'BF-Bc: unexpected symbol format',
      'XYZc: no valid contract address',
      'NVDAc: duplicate symbol',
      '(no symbol): unexpected symbol format',
    ]);
  });
});

describe('discover-tokens digest', () => {
  const run = async () => (await GET(new NextRequest('http://x/api/cron/discover-tokens?dry=1'))).json();

  it('reports skipped tokens even when no pool is new', async () => {
    LIST.tokens = [
      { symbol: 'NEWc', name: 'New Co', contract_address: A(9) },
      { symbol: 'BF-Bc', name: 'Brown-Forman', contract_address: A(3) },
    ];
    const body = await run();
    expect(body.dry).toBe(true);
    expect(body.digest).toContain('Skipped: Coinbase lists 1 token that /stocks and this check leave out');
    expect(body.digest).toContain(`BF-Bc — ${A(3)} — unexpected symbol format`);
    expect(body.digest).not.toContain('New Aero or Aerodrome USDC pools');
  });

  it('says nothing when nothing is skipped and no pool is new', async () => {
    LIST.tokens = [{ symbol: 'NEWc', name: 'New Co', contract_address: A(9) }];
    const body = await run();
    expect(body.digest).toBeUndefined();
    expect(body.reported).toBe(0);
  });
});
