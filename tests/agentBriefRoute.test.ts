import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TapeRow } from '../lib/market/tape';

// Offline: the tape, the pools, the depth readings, Claude and the limiters are fakes.
vi.mock('server-only', () => ({}));
const fx = vi.hoisted(() => ({ explained: null as string | null, why: 'refused-by-check', explainCalls: 0, configured: true, limiters: true, allow: true }));
const row = (symbol: string): TapeRow => ({
  symbol, cashTicker: symbol.replace(/c$/, ''), name: symbol, cashLastUsd: 100, cashAsOfMs: 0, cashPriceType: 'regular', cashStale: false,
  closeUsd: 100, closeAsOfMs: 0, onchainMidUsd: 100.1, tick: 0, basisBp: 10, depthUsd: 5_000_000, depthShares: 0, multiplier: 1, nextEarningsDate: null,
});
vi.mock('../lib/market/tape', () => ({
  getTape: async () => ({
    rows: ['NVDAc', 'MUc', 'AMDc'].map(row),
    fetchedAt: 0,
    session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-13', nextOpenIso: '2026-11-14T14:30:00.000Z' },
  }),
}));
vi.mock('../lib/market/lotQuote', () => ({
  getBuyQuoter: async () => ({ estimate: (u: number) => ({ sharesOut: u / 100, impactBp: 5 }), sizeForImpact: () => 1e9 }),
}));
vi.mock('../lib/market/depthSamples', () => ({
  getRecentDepthSamples: async () => [],
  steadyDepth: (_s: unknown, _sym: string, now: number) => ({ usd: 2_000_000, asOfMs: now - 60_000, samples: 36, sinceMs: now - 3 * 3_600_000 }),
}));
vi.mock('../lib/agent/planStats', () => ({ countPlanBriefly: async () => {} }));
vi.mock('../lib/agent/explain', () => ({
  explainerConfigured: () => fx.configured,
  explainBrief: async () => {
    fx.explainCalls++;
    return fx.explained != null ? { text: fx.explained } : { text: null, why: fx.why };
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

import { POST } from '../app/api/agent/brief/route';

let ip = 0;
const post = (body: unknown) =>
  POST(new Request('http://local/api/agent/brief', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${++ip}` }, body: JSON.stringify(body) }));
const brief = { theme: 'AI chips', budgetUsd: 900, minStocks: 3 };

describe('POST /api/agent/brief', () => {
  beforeEach(() => Object.assign(fx, { explained: null, why: 'refused-by-check', explainCalls: 0, configured: true, limiters: true, allow: true }));

  it('answers a plain-language 400 for bad input', async () => {
    const res = await post({ theme: 'Crypto', budgetUsd: 900 });
    expect(res.status).toBe(400);
  });
  it('builds the basket and uses Claude’s words when it answers', async () => {
    fx.explained = 'Your basket holds three stocks. Nothing is bought until you sign each step in your own wallet.';
    const body = await (await post(brief)).json();
    expect(body.brief.picks.map((p: { symbol: string }) => p.symbol)).toEqual(['AMDc', 'MUc', 'NVDAc']);
    expect(body.explainedBy).toBe('claude');
    expect(body.fixedBecause).toBeNull();
  });
  it('says why the fixed words were used: refused, cut off, over the limit, no limiter, no key', async () => {
    let body = await (await post(brief)).json();
    expect([body.explainedBy, body.fixedBecause]).toEqual(['fixed', 'refused-by-check']);
    fx.why = 'cut-off';
    body = await (await post(brief)).json();
    expect(body.fixedBecause).toBe('cut-off');
    fx.allow = false;
    fx.explainCalls = 0;
    body = await (await post(brief)).json();
    expect(body.fixedBecause).toBe('rate-limited');
    fx.allow = true;
    fx.limiters = false;
    body = await (await post(brief)).json();
    expect(body.fixedBecause).toBe('no-limiter');
    fx.limiters = true;
    fx.configured = false;
    body = await (await post(brief)).json();
    expect(body.fixedBecause).toBe('not-configured');
    expect(fx.explainCalls).toBe(0);
    expect(body.explanation).toMatch(/Nothing is bought until you review the basket/);
  });
});
