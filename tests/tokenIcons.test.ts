import { describe, expect, it, vi, beforeEach } from 'vitest';

// The root layout awaits getTokenIcons on every page (2026-11-25): a slow Coinbase list must not hold the page.
const fx = vi.hoisted(() => ({ wait: 0, fail: false, calls: 0 }));
vi.mock('../lib/stocks/coinbaseListGuard', () => ({
  getCoinbaseStockList: async () => {
    fx.calls++;
    await new Promise((r) => setTimeout(r, fx.wait));
    if (fx.fail) throw new Error('down');
    return [{ contract_address: '0xNVDA', icon_url: 'https://metadata.coinbase.com/equity_icons/nvda.png' }];
  },
}));
vi.mock('../lib/stocks/tokens', () => ({ STOCKS: [{ tokenAddress: '0xnvda', cashTicker: 'NVDA' }] }));

beforeEach(() => Object.assign(fx, { wait: 0, fail: false, calls: 0 }));

describe('getTokenIcons', () => {
  it('a slow list: the page gets letter tiles after the wait, and the next page gets the icons the read brought back', async () => {
    vi.resetModules();
    const { getTokenIcons } = await import('../lib/stocks/coinbaseIcons');
    fx.wait = 200;
    const t0 = Date.now();
    expect(await getTokenIcons(20)).toEqual({});
    expect(Date.now() - t0).toBeLessThan(150);
    await new Promise((r) => setTimeout(r, 250));
    fx.wait = 1000; // the next read is slow too: the last good map is used meanwhile
    const icons = await getTokenIcons(20);
    expect(Object.keys(icons)).toEqual(['NVDA']);
  });
  it('a quick list is returned as is; one read at a time', async () => {
    vi.resetModules();
    const { getTokenIcons } = await import('../lib/stocks/coinbaseIcons');
    const [a, b] = await Promise.all([getTokenIcons(500), getTokenIcons(500)]);
    expect(a).toEqual(b);
    expect(fx.calls).toBe(1);
  });
});
