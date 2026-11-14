import { describe, expect, it, vi } from 'vitest';
import type { TapeRow } from '../lib/market/tape';

// Offline: the tape and the pools are fakes; no Redis, no chain.
vi.mock('server-only', () => ({}));
const row = (symbol: string): TapeRow => ({
  symbol, cashTicker: symbol.replace(/c$/, ''), name: symbol, cashLastUsd: 100, cashAsOfMs: 0, cashPriceType: 'regular', cashStale: false,
  closeUsd: 100, closeAsOfMs: 0, onchainMidUsd: 100.1, tick: 0, basisBp: 10, depthUsd: 5_000_000, depthShares: 0, multiplier: 1, nextEarningsDate: null,
});
vi.mock('../lib/market/tape', () => ({
  getTape: async () => ({
    rows: ['NVDAc', 'MSFTc', 'AAPLc'].map(row),
    fetchedAt: 0,
    session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-14', nextOpenIso: '2026-11-16T14:30:00.000Z' },
  }),
}));
vi.mock('../lib/market/lotQuote', () => ({
  getBuyQuoter: async () => ({ estimate: (u: number) => ({ sharesOut: u / 100, impactBp: 5 }), sizeForImpact: () => 1e9 }),
}));
vi.mock('../lib/agent/planStats', () => ({ countRuleCheckBriefly: async () => {} }));

import { POST } from '../app/api/agent/rebalance-check/route';

let ip = 0;
const post = (body: unknown) =>
  POST(new Request('http://local/api/agent/rebalance-check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.2.0.${++ip}` }, body: JSON.stringify(body) }));
const targets = [
  { symbol: 'NVDAc', weightPct: 50 },
  { symbol: 'MSFTc', weightPct: 50 },
];
const ok = { targets, usd: 100, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 0, balances: { NVDAc: '0', MSFTc: '0' } };

describe('POST /api/agent/rebalance-check', () => {
  it('refuses bad targets, amounts, limits and holdings in plain words', async () => {
    expect((await post({ ...ok, targets: [{ symbol: 'NVDAc', weightPct: 100 }] })).status).toBe(400);
    expect((await post({ ...ok, usd: 5 })).status).toBe(400);
    expect((await post({ ...ok, maxCostBp: null })).status).toBe(400);
    expect((await post({ ...ok, balances: { NVDAc: '0' } })).status).toBe(400);
    expect((await post({ ...ok, balances: { NVDAc: '-1', MSFTc: '0' } })).status).toBe(400);
    expect((await post({ ...ok, balances: { NVDAc: 1.5, MSFTc: '0' } })).status).toBe(400);
  });
  it('answers the drift view and the basket for a due run, and takes no address', async () => {
    const res = await post(ok);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.picks.map((p: { symbol: string; usd: number }) => [p.symbol, p.usd])).toEqual([
      ['NVDAc', 50],
      ['MSFTc', 50],
    ]);
    expect(body.plan.basket).toEqual([
      { symbol: 'NVDAc', weightPct: 50 },
      { symbol: 'MSFTc', weightPct: 50 },
    ]);
    expect(body.plan.drift).toHaveLength(2);
    expect(typeof body.checkedAt).toBe('number');
  });
});
