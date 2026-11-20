import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();
const redisFail = { on: false };
const failSet = { key: '' };
vi.mock('@/lib/server/redis', () => ({
  redis: {
    get: async (k: string) => {
      if (redisFail.on) throw new Error('redis down');
      return store.get(k) ?? null;
    },
    set: async (k: string, v: unknown) => {
      if (failSet.key === k) throw new Error('write failed');
      store.set(k, v);
    },
  },
}));
const fresh = { list: [] as Record<string, unknown>[] };
vi.mock('@/lib/stocks/coinbaseStockList', async (orig) => ({
  ...(await orig<object>()),
  fetchCoinbaseStockList: async () => fresh.list,
}));

const tok = (i: number, addr?: string) => ({ symbol: `T${i}c`, contract_address: addr ?? `0x${i.toString(16).padStart(40, '0')}`, name: `Token ${i}`, icon_url: null, description: 'long text' });
const TRACKED = [{ symbol: 'AAAc', tokenAddress: '0x' + 'a'.repeat(40) }];
import { STOCKS } from '@/lib/stocks/tokens';
/** For the pure judge: a list holding the one synthetic tracked stock, or not. */
const listA = (n: number, withTracked = true) => [...(withTracked ? [tok(0, TRACKED[0].tokenAddress)] : []), ...Array.from({ length: n - (withTracked ? 1 : 0) }, (_, i) => tok(i + 1))];
/** End to end: the real tracked stocks first (so the list can be saved), then made-up tokens up to n. */
const list = (n: number, withTracked = true) => {
  const tracked = withTracked ? STOCKS.slice(0, n).map((st, i) => tok(1000 + i, st.tokenAddress)) : [];
  return [...tracked, ...Array.from({ length: Math.max(0, n - tracked.length) }, (_, i) => tok(i + 1))];
};

describe('judgeCoinbaseList', () => {
  it('flags a drop of more than 25% and missing tracked stocks', async () => {
    const { judgeCoinbaseList } = await import('@/lib/stocks/coinbaseListGuard');
    const last = { at: 0, tokens: listA(100) as never };
    expect(judgeCoinbaseList(listA(80), last, TRACKED)).toMatchObject({ shrunk: false, missingTracked: [] });
    expect(judgeCoinbaseList(listA(74), last, TRACKED)).toMatchObject({ shrunk: true });
    expect(judgeCoinbaseList(listA(100, false), last, TRACKED)).toMatchObject({ shrunk: false, missingTracked: ['AAAc'] });
    expect(judgeCoinbaseList(listA(5), null, TRACKED)).toMatchObject({ shrunk: false, lastGoodCount: null });
  });
});

describe('the guard end to end (mocked Redis and fetch)', () => {
  beforeEach(() => {
    store.clear();
    redisFail.on = false;
    failSet.key = '';
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
    await g.checkCoinbaseList(list(90) as never);
    fresh.list = [tok(500)];
    const ex = await g.getStockTokenExclusions();
    expect(ex.has(tok(500).contract_address.toLowerCase())).toBe(true);
    expect(ex.has(tok(90 - STOCKS.length).contract_address.toLowerCase())).toBe(true); // a made-up token only in the last good list
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
    const r = await g.checkCoinbaseList(list(90, false) as never);
    expect(r.missingTracked).toHaveLength(STOCKS.length);
    expect(r.alerts.join(' ')).toMatch(/Tracked stocks missing/);
  });

  it('a slow shrink never walks the baseline down, and a drop over 10% alerts', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    await g.checkCoinbaseList(list(95) as never);
    const r1 = await g.checkCoinbaseList(list(76) as never); // -20%: used, alerted, not saved
    expect(r1).toMatchObject({ shrunk: false, saved: false });
    expect(r1.alerts.join(' ')).toMatch(/dropped from 95 to 76/);
    const r2 = await g.checkCoinbaseList(list(60) as never); // still compared with 95: -37%, shrunk
    expect(r2.shrunk).toBe(true);
    expect(r2.useList).toHaveLength(95);
    const r3 = await g.checkCoinbaseList(list(92) as never); // -3%: used, no alert, not saved
    expect(r3).toMatchObject({ saved: false, shrunk: false });
    expect(r3.alerts.join(' ')).not.toMatch(/dropped|shrank/);
    expect((store.get('cblist:lastgood') as { tokens: unknown[] }).tokens).toHaveLength(95);
    const r4 = await g.checkCoinbaseList(list(100) as never); // growth with every tracked stock: saved
    expect(r4.saved).toBe(true);
  });

  it('never saves a list with a tracked stock missing', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    const withTracked = (n: number) => list(STOCKS.length + n);
    expect((await g.checkCoinbaseList(withTracked(50) as never)).saved).toBe(true);
    const r = await g.checkCoinbaseList(list(100, false) as never); // count grew, every tracked stock gone
    expect(r.saved).toBe(false);
    expect(r.alerts.join(' ')).toMatch(/Tracked stocks missing/);
    expect((store.get('cblist:lastgood') as { tokens: unknown[] }).tokens).toHaveLength(STOCKS.length + 50);
    expect((await g.checkCoinbaseList(withTracked(60) as never)).saved).toBe(true);
  });

  it('alerts once when a condition starts, again if it changes, and retries a failed send', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    // What the cron does: check, send, record what was sent (`ok` says whether the send worked).
    const run = async (n: number, ok = true) => {
      const r = await g.checkCoinbaseList(list(n) as never);
      await g.recordGuardAlerts(r, new Set(ok ? r.toSend.map((c) => c.key) : []), false);
      return r.toSend.map((c) => c.text).join(' ');
    };
    await run(95);
    expect(await run(84, false)).toMatch(/dropped/); // the send fails...
    expect(await run(84)).toMatch(/dropped/); // ...so it is sent again
    expect(await run(84)).not.toMatch(/dropped/); // then quiet
    expect(await run(76)).toMatch(/dropped from 95 to 76/); // deeper band: again
    expect(await run(60)).toMatch(/shrank/);
    expect(await run(95)).toBe(''); // recovered
    expect(await run(84)).toMatch(/dropped/); // started again
  });

  it('the frozen report is timed from the last report, so a missed day doesn\u2019t skip it', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    const t0 = Date.UTC(2026, 10, 19, 13);
    const day = (d: number) => t0 + d * 86_400_000;
    const run = async (now: number, sentOk = true) => {
      const r = await g.checkCoinbaseList(list(89) as never, { now });
      await g.recordGuardAlerts(r, new Set(), !!r.staleReport && sentOk, now);
      return r.staleReport ?? '';
    };
    await g.checkCoinbaseList(list(90) as never, { now: t0 });
    expect(await run(day(8), false)).toMatch(/8 days old/); // day 7 missed; the send fails
    expect(await run(day(9))).toMatch(/9 days old/); // so it goes out the next day
    expect(await run(day(10))).toBe('');
    expect(await run(day(16))).toMatch(/16 days old/);
  });

  it('a failed alert-state write still saves the weekly report time', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    failSet.key = 'cblist:alertstate';
    await expect(g.recordGuardAlerts({ conditionKeys: ['drop:10'], previousKeys: [] }, new Set(['drop:10']), true, 123)).rejects.toThrow(/write failed/);
    expect(store.get('cblist:stalereport')).toBe(123);
  });

  it('dry runs write nothing', async () => {
    const g = await import('@/lib/stocks/coinbaseListGuard');
    const r = await g.checkCoinbaseList(list(90) as never, { dry: true });
    expect(r.saved).toBe(false);
    expect(store.size).toBe(0);
  });
});
