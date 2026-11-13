import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TapeRow } from '../lib/market/tape';

// Offline: the tape, the pools, Claude and the limiters are fakes.
vi.mock('server-only', () => ({}));
const fx = vi.hoisted(() => ({ explained: null as string | null, explainCalls: 0, configured: true, limiters: true, allow: true }));
vi.mock('../lib/market/tape', () => ({
  getTape: async () => ({
    rows: [
      {
        symbol: 'NVDAc', cashTicker: 'NVDA', name: 'NVIDIA', cashLastUsd: 100, cashAsOfMs: 0, cashPriceType: 'regular', cashStale: false,
        closeUsd: 100, closeAsOfMs: 0, onchainMidUsd: 100.1, tick: 0, basisBp: 10, depthUsd: 5_000_000, depthShares: 0, multiplier: 1, nextEarningsDate: null,
      } satisfies TapeRow,
    ],
    fetchedAt: 0,
    session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-09', nextOpenIso: '2026-11-10T14:30:00.000Z' },
  }),
}));
vi.mock('../lib/market/lotQuote', () => ({
  getBuyQuoter: async () => ({ estimate: (u: number) => ({ sharesOut: u / 100, impactBp: 5 }), sizeForImpact: () => 1e9 }),
}));
vi.mock('../lib/agent/explain', () => ({
  explainerConfigured: () => fx.configured,
  explainPlan: async () => {
    fx.explainCalls++;
    return fx.explained != null ? { text: fx.explained } : { text: null, why: 'refused-by-check' };
  },
}));
vi.mock('../lib/server/ratelimit', async (orig) => {
  const real = await orig<typeof import('../lib/server/ratelimit')>();
  const lim = { limit: async () => ({ success: fx.allow, reset: 0 }) };
  return {
    ...real,
    get agentLimiter() { return fx.limiters ? lim : null; },
    get agentDailyLimiter() { return fx.limiters ? lim : null; },
  };
});

import { POST } from '../app/api/agent/plan/route';

let ip = 0;
const post = (body: unknown) =>
  POST(new Request('http://local/api/agent/plan', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++ip}` }, body: JSON.stringify(body) }));

describe('POST /api/agent/plan', () => {
  beforeEach(() => Object.assign(fx, { explained: null, explainCalls: 0, configured: true, limiters: true, allow: true }));

  it('answers a plain-language 400 for bad input', async () => {
    const res = await post({ symbols: ['NOPEc'], budgetUsd: 100 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown symbol: NOPEc');
    expect((await (await post({ budgetUsd: 1 })).json()).error).toBe('the budget must be between $10 and $100,000');
  });
  it('plans and uses Claude’s words when it answers', async () => {
    fx.explained = 'One buy passes your limits. Nothing is bought until you sign it in your own wallet.';
    const body = await (await post({ symbols: ['NVDAc'], budgetUsd: 1000 })).json();
    expect(body.plan.legs[0]).toMatchObject({ symbol: 'NVDAc', verdict: 'buy', usd: 1000 });
    expect(body.explainedBy).toBe('claude');
    expect(body.fixedBecause).toBeNull();
  });
  it('falls back to fixed words when Claude returns nothing, is over its limits, or Redis is missing', async () => {
    let body = await (await post({ symbols: ['NVDAc'], budgetUsd: 1000 })).json();
    expect(body.explainedBy).toBe('fixed');
    expect(body.explanation).toMatch(/One buy passes your limits/);
    expect(body.fixedBecause).toBe('refused-by-check');
    fx.allow = false;
    fx.explainCalls = 0;
    body = await (await post({ symbols: ['NVDAc'], budgetUsd: 1000 })).json();
    expect(body.explainedBy).toBe('fixed');
    expect(body.fixedBecause).toBe('rate-limited');
    expect(fx.explainCalls).toBe(0);
    fx.allow = true;
    fx.limiters = false;
    body = await (await post({ symbols: ['NVDAc'], budgetUsd: 1000 })).json();
    expect(body.fixedBecause).toBe('no-limiter');
    expect(fx.explainCalls).toBe(0);
  });
  it('holds one caller to 10 plans a minute', async () => {
    const req = () => POST(new Request('http://local/api/agent/plan', { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ budgetUsd: 100 }) }));
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await req()).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});
