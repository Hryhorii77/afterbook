import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const redisFail = { on: false };
vi.mock('@/lib/server/redis', () => ({
  redis: {
    get: async (k: string) => {
      if (redisFail.on) throw new Error('redis down');
      return store.get(k) ?? null;
    },
    set: async (k: string, v: unknown) => void store.set(k, v),
  },
}));
const fresh = { list: [] as Record<string, unknown>[] };
vi.mock('@/lib/stocks/coinbaseStockList', async (orig) => ({
  ...(await orig<object>()),
  fetchCoinbaseStockList: async () => fresh.list,
}));

const tok = (i: number, addr?: string) => ({ symbol: `T${i}c`, contract_address: addr ?? `0x${i.toString(16).padStart(40, '0')}`, name: `Token ${i}`, icon_url: null, description: 'long text' });
const TRACKED = [{ symbol: 'AAAc', tokenAddress: '0x' + 'a'.repeat(40) }];
const list = (n: number, withTracked = true) => [...(withTracked ? [tok(0, TRACKED[0].tokenAddress)] : []), ...Array.from({ length: n - (withTracked ? 1 : 0) }, (_, i) => tok(i + 1))];

describe('judgeCoinbaseList', () => {
  it('flags a drop of more than 25% and missing tracked stocks', async () => {
    const { judgeCoinbaseList } = await import('@/lib/stocks/coinbaseListGuard');
    const last = { at: 0, tokens: list(100) as never };
    expect(judgeCoinbaseList(list(80), last, TRACKED)).toMatchObject({ shrunk: false, missingTracked: [] });
    expect(judgeCoinbaseList(list(74), last, TRACKED)).toMatchObject({ shrunk: true });
    expect(judgeCoinbaseList(list(100, false), last, TRACKED)).toMatchObject({ shrunk: false, missingTracked: ['AAAc'] });
    expect(judgeCoinbaseList(list(5), null, TRACKED)).toMatchObject({ shrunk: false, lastGoodCount: null });
  });
});

describe('the guard end to end (mocked Redis and fetch)', () => {
  beforeEach(() => {
    store.clear();
    redisFail.on = false;
    vi.resetModules();
  });

  it('never takes a collapsed list as the baseline when Redis fails or holds junk', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    await g.checkCoinbaseList(list(90) as never);
    redisFail.on = true;
    await expect(g.checkCoinbaseList(list(10) as never)).rejects.toThrow(/redis down/);
    redisFail.on = false;
    expect((store.get('cblist:lastgood') as { tokens: unknown[] }).tokens).toHaveLength(90);
    store.set('cblist:lastgood', { at: 1, tokens: [] });
    await expect(g.checkCoinbaseList(list(10) as never)).rejects.toThrow(/unreadable/);
  });

  it('counts only real entries, so junk padding cannot hide a drop', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    await g.checkCoinbaseList(list(90) as never);
    const padded = [...list(40), ...Array.from({ length: 60 }, () => ({ symbol: 'X' }))];
    const r = await g.checkCoinbaseList(padded as never);
    expect(r.shrunk).toBe(true);
    expect(r.freshCount).toBe(40);
  });

  it('the meme exclusions are the union of tracked, fresh and last good', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    const { STOCKS } = await import('@/lib/stocks/tokens');
    await g.checkCoinbaseList(list(90) as never);
    fresh.list = [tok(500)];
    const ex = await g.getStockTokenExclusions();
    expect(ex.has(tok(500).contract_address.toLowerCase())).toBe(true);
    expect(ex.has(tok(89).contract_address.toLowerCase())).toBe(true);
    expect(STOCKS.every((s) => ex.has(s.tokenAddress.toLowerCase()))).toBe(true);
  });

  it('takes the first list as the baseline, slimmed', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    fresh.list = list(90);
    const r = await g.checkCoinbaseList(fresh.list as never);
    expect(r.saved).toBe(true);
    expect(r.shrunk).toBe(false);
    expect(r.alerts.join(' ')).not.toMatch(/shrank/);
    const saved = store.get('cblist:lastgood') as { tokens: Record<string, unknown>[] };
    expect(saved.tokens).toHaveLength(90);
    expect(saved.tokens[0]).not.toHaveProperty('description');
  });

  it('keeps the last good list for readers and alerts when the list shrinks too far', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    await g.checkCoinbaseList(list(90) as never);
    fresh.list = list(60);
    const r = await g.checkCoinbaseList(fresh.list as never);
    expect(r.saved).toBe(false);
    expect(r.alerts.join(' ')).toMatch(/shrank from 90 to 60/);
    expect((store.get('cblist:lastgood') as { tokens: unknown[] }).tokens).toHaveLength(90);
    expect(await g.getCoinbaseStockList()).toHaveLength(90);
  });

  it('uses the fresh list when it holds, and alerts on a missing tracked stock', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    await g.checkCoinbaseList(list(90) as never);
    fresh.list = list(85);
    expect(await g.getCoinbaseStockList()).toHaveLength(85);
    const tracked = (await import('@/lib/stocks/tokens')).STOCKS;
    const r = await g.checkCoinbaseList(list(90, false) as never);
    // None of the real tracked addresses are in this synthetic list, so every tracked stock is reported missing.
    expect(r.missingTracked).toHaveLength(tracked.length);
    expect(r.alerts.join(' ')).toMatch(/Tracked stocks missing/);
  });

  it('dry runs write nothing', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    const r = await g.checkCoinbaseList(list(90) as never, { dry: true });
    expect(r.saved).toBe(false);
    expect(store.size).toBe(0);
  });
});
