import { describe, expect, it, vi } from 'vitest';
import type { TapeRow } from '../lib/market/tape';

// Offline: the tape and the pools are fakes. No Claude is involved in a rule check.
vi.mock('server-only', () => ({}));
const row = (p: Partial<TapeRow>): TapeRow => ({
  symbol: 'NVDAc', cashTicker: 'NVDA', name: 'NVIDIA', cashLastUsd: 100, cashAsOfMs: 0, cashPriceType: 'regular', cashStale: false,
  closeUsd: 100, closeAsOfMs: 0, onchainMidUsd: 100.1, tick: 0, basisBp: 10, depthUsd: 5_000_000, depthShares: 0, multiplier: 1, nextEarningsDate: null,
  ...p,
});
vi.mock('../lib/market/tape', () => ({
  getTape: async () => ({
    rows: [row({}), row({ symbol: 'METAc', cashTicker: 'META', name: 'Meta', onchainMidUsd: 102, basisBp: 200 })],
    fetchedAt: 0,
    session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-09', nextOpenIso: '2026-11-10T14:30:00.000Z' },
  }),
}));
vi.mock('../lib/market/lotQuote', () => ({
  getBuyQuoter: async () => ({ estimate: (u: number) => ({ sharesOut: u / 100, impactBp: 5 }), sizeForImpact: () => 1e9 }),
}));

import { POST } from '../app/api/agent/rule-check/route';

let ip = 0;
const post = (body: unknown) =>
  POST(new Request('http://local/api/agent/rule-check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.1.0.${++ip}` }, body: JSON.stringify(body) }));

describe('POST /api/agent/rule-check', () => {
  it('passes and sizes a run inside its limits', async () => {
    const res = await post({ symbol: 'NVDAc', usd: 50, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leg).toMatchObject({ symbol: 'NVDAc', verdict: 'buy', usd: 50 });
    expect(body.explanation).toBeUndefined();
  });
  it('waits when the token trades over the premium set', async () => {
    const body = await (await post({ symbol: 'METAc', usd: 50, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 0 })).json();
    expect(body.leg.verdict).toBe('wait');
    expect(body.leg.decidedBy).toMatch(/more than the/);
  });
  it('refuses bad input in plain words', async () => {
    expect((await (await post({ symbol: 'NVDAc', usd: 5 })).json()).error).toBe('a run must be between $10 and $25,000');
    expect((await (await post({ symbol: 'NVDAc', usd: 30_000 })).json()).error).toBe('a run must be between $10 and $25,000');
    expect((await (await post({ symbol: 'NOPEc', usd: 50 })).json()).error).toBe('unknown symbol: NOPEc');
    expect((await post({ usd: 50 })).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
  });
});
