import { describe, expect, it, vi, beforeEach } from 'vitest';

// Offline: a fake Redis that records commands, no chain, no KyberSwap.
const r = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const hashes = new Map<string, Record<string, number>>();
  const calls: string[] = [];
  const pipeline = () => {
    const ops: (() => unknown)[] = [];
    const p = {
      hincrby: (k: string, f: string, n: number) => (ops.push(() => { calls.push(`hincrby ${k} ${f}`); const h = (hashes.get(k) ?? {}); h[f] = (h[f] ?? 0) + n; hashes.set(k, h); return h[f]; }), p),
      hgetall: (k: string) => (ops.push(() => hashes.get(k) ?? null), p),
      exec: async () => ops.map((o) => o()),
    };
    return p;
  };
  return {
    store, hashes, calls,
    redis: {
      pipeline,
      set: async (k: string, v: unknown) => { store.set(k, v); return 'OK'; },
      expire: async (k: string) => { calls.push(`expire ${k}`); return 1; },
      zrange: async () => [...store.keys()].filter((k) => k.startsWith('swap:')).map((k) => k.slice(5)),
      mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null),
    },
  };
});
vi.mock('@/lib/server/redis', () => ({ redis: r.redis }));
vi.mock('../lib/server/redis', () => ({ redis: r.redis }));

const built = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock('@/lib/swap/swapGuard', () => ({ guardSwapRequest: async () => null }));
vi.mock('@/lib/swap/swap', async (orig) => ({
  ...(await orig<typeof import('../lib/swap/swap')>()),
  buildSwap: async () => ({ data: '0x01', quote: { symbol: 'NVDAc', side: 'buy', feeBps: 0, amountInUsd: 100 } }),
}));
vi.mock('@/lib/swap/swapLog', async (orig) => ({
  ...(await orig<typeof import('../lib/swap/swapLog')>()),
  rememberBuiltSwap: async (_tx: unknown, _a: unknown, source: string) => void built.sources.push(source),
}));

import { NextRequest } from 'next/server';
import { POST as build } from '../app/api/swap/build/route';
import { countPlan, planStats } from '../lib/agent/planStats';
import { swapStats } from '../lib/swap/swapLog';

const ACCOUNT = '0x9b3F0000000000000000000000000000000006Ba';

describe('swap build label', () => {
  beforeEach(() => (built.sources = []));
  it('labels a plan buy "plan", a basket leg "basket", anything else "stock"', async () => {
    for (const source of ['plan', 'basket', undefined, 'meme', 'anything']) {
      const res = await build(new NextRequest('http://local/api/swap/build', { method: 'POST', body: JSON.stringify({ symbol: 'NVDAc', side: 'buy', amountIn: '100000000', account: ACCOUNT, source }) }));
      expect(res.status).toBe(200);
    }
    // A stock swap can't claim to be a meme buy: only a meme request is labelled 'meme'.
    expect(built.sources).toEqual(['plan', 'basket', 'stock', 'stock', 'stock']);
  });
});

describe('plan counters', () => {
  beforeEach(() => {
    r.calls.length = 0;
    r.hashes.clear();
  });
  it('counts plans per UTC day, with Claude and with-a-buy, and keeps nothing else', async () => {
    const day = Date.parse('2026-11-08T12:00:00Z');
    await countPlan({ explainedBy: 'claude', buys: 2 }, day);
    await countPlan({ explainedBy: 'fixed', buys: 0 }, day);
    await countPlan({ explainedBy: 'claude', buys: 0 }, day + 86_400_000);
    expect(r.calls.filter((c) => c.startsWith('hincrby'))).toEqual([
      'hincrby stats:plans:2026-11-08 made', 'hincrby stats:plans:2026-11-08 claude', 'hincrby stats:plans:2026-11-08 withBuy',
      'hincrby stats:plans:2026-11-08 made',
      'hincrby stats:plans:2026-11-09 made', 'hincrby stats:plans:2026-11-09 claude',
    ]);
    // The expiry is set once per day key, on its first plan.
    expect(r.calls.filter((c) => c.startsWith('expire'))).toEqual(['expire stats:plans:2026-11-08', 'expire stats:plans:2026-11-09']);
    const s = await planStats(7, day + 86_400_000);
    expect(s?.total).toEqual({ made: 3, claude: 2, withBuy: 1 });
    expect(s?.byDay['2026-11-08']).toEqual({ made: 2, claude: 1, withBuy: 1 });
  });
  it('waits at most a moment for a slow Redis', async () => {
    const { countPlanBriefly } = await import('../lib/agent/planStats');
    const spy = vi.spyOn(r.redis, 'pipeline').mockImplementationOnce(() => ({ hincrby() { return this; }, exec: () => new Promise(() => {}) }) as never);
    const t = Date.now();
    await countPlanBriefly({ explainedBy: 'fixed', buys: 0 }, 50);
    expect(Date.now() - t).toBeLessThan(500);
    spy.mockRestore();
  });
  it('never throws when Redis fails', async () => {
    const spy = vi.spyOn(r.redis, 'pipeline').mockImplementationOnce(() => { throw new Error('down'); });
    await expect(countPlan({ explainedBy: 'fixed', buys: 1 })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('swap stats by source', () => {
  beforeEach(() => r.store.clear());
  it('counts plan swaps with their own distinct wallets', async () => {
    const now = Date.now();
    const rec = (hash: string, wallet: string, source?: string, usd = 10) => r.store.set(`swap:${hash}`, { hash, at: now, symbol: 'NVDAc', side: 'buy', usd, feeBps: 0, feeUsd: 0, wallet, source });
    rec('a', 'w1', 'plan');
    rec('b', 'w1', 'plan', 25);
    rec('c', 'w2', 'plan');
    rec('d', 'w3');
    const s = await swapStats(7);
    expect(s?.bySource.plan).toEqual({ swaps: 3, volumeUsd: 45, traders: 2 });
    expect(s?.bySource.stock).toEqual({ swaps: 1, volumeUsd: 10, traders: 1 });
    expect(s?.traders).toBe(3);
  });
  it('does not count a swap logged without a wallet as a trader', async () => {
    const now = Date.now();
    r.store.set('swap:old', { hash: 'old', at: now, symbol: 'NVDAc', side: 'buy', usd: 10, feeBps: 0, feeUsd: 0 });
    r.store.set('swap:new', { hash: 'new', at: now, symbol: 'NVDAc', side: 'buy', usd: 10, feeBps: 0, feeUsd: 0, wallet: 'w9' });
    const s = await swapStats(7);
    expect(s?.swaps).toBe(2);
    expect(s?.traders).toBe(1);
  });
});
