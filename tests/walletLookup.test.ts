import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { normalizeBasename, parseWalletInput } from '../lib/wallet/walletInput';

// "Look up a wallet" (2026-11-26): what can be typed, and the read-only routes behind it. Offline: chain reads are fakes.
vi.mock('server-only', () => ({}));
const fx = vi.hoisted(() => ({ forward: {} as Record<string, string | null>, calls: [] as string[], fail: false }));
vi.mock('../lib/wallet/basename', () => ({
  addressOfBasename: async (n: string) => {
    fx.calls.push(n);
    if (fx.fail) throw new Error('rpc down');
    return fx.forward[n] ?? null;
  },
  resolveBasename: async () => null,
}));
vi.mock('../lib/lending/loanReport', () => ({ loanHealthReport: async (w: string, t: number) => ({ wallet: w, threshold: t, loans: [] }) }));

import { GET as basenameGET } from '../app/api/basename/route';
import { GET as loansGET } from '../app/api/loans/route';

let ip = 0;
const req = (path: string) => new NextRequest(`https://afterbook.app${path}`, { headers: { 'x-forwarded-for': `10.9.0.${++ip}` } });

describe('wallet lookup input', () => {
  it('takes a 0x address (any case, checksummed back) or a Basename', () => {
    expect(parseWalletInput(' 0x2211d1d0020daea8039e46cf1367962070d77da9 ')).toEqual({ kind: 'address', address: '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9' });
    expect(parseWalletInput('Jesse')).toEqual({ kind: 'name', name: 'jesse.base.eth' });
    expect(parseWalletInput('jesse.base.eth')).toEqual({ kind: 'name', name: 'jesse.base.eth' });
  });
  it('refuses anything else', () => {
    for (const s of ['', '0x123', 'vitalik.eth', 'a b', '-x', 'x'.repeat(64), '<script>', 'jesse.base.eth.evil', '0x2211d1d0020daea8039e46cf1367962070d77da9z'])
      expect(parseWalletInput(s)).toBeNull();
    expect(normalizeBasename('a.b.base.eth')).toBeNull(); // one label only
  });
});

describe('the read-only routes', () => {
  it('/api/basename?name= returns the address a Basename points to, refusing what isn’t one', async () => {
    fx.forward['jesse.base.eth'] = '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9';
    const ok = await basenameGET(req('/api/basename?name=Jesse'));
    expect(await ok.json()).toEqual({ name: 'jesse.base.eth', address: '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9' });
    const none = await basenameGET(req('/api/basename?name=nobody'));
    expect((await none.json()).address).toBeNull();
    const bad = await basenameGET(req('/api/basename?name=vitalik.eth'));
    expect(bad.status).toBe(400);
    // A read failure is a 502, never "points to no wallet" (review of #247).
    fx.fail = true;
    const down = await basenameGET(req('/api/basename?name=jesse'));
    expect(down.status).toBe(502);
    fx.fail = false;
  });
  it('/api/loans reads any valid address at the default alert line, and refuses anything else', async () => {
    const ok = await loansGET(req('/api/loans?address=0x2211d1d0020daea8039e46cf1367962070d77da9'));
    expect(await ok.json()).toEqual({ wallet: '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9', threshold: 1.2, loans: [] });
    expect((await loansGET(req('/api/loans?address=jesse'))).status).toBe(400);
    expect((await loansGET(req('/api/loans'))).status).toBe(400);
  });
});
