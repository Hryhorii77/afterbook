import { describe, expect, it } from 'vitest';
import { planReceipts } from '../lib/agent/planReceipt';
import type { SavedStockPlan } from '../lib/agent/planLink';
import type { SwapRecord } from '../lib/swap/swapLog';

// Plan receipts (2026-11-25): a plan link's verified fills against what the plan promised.
const saved = {
  v: 1,
  id: 'AbCdEfGhIjKlMnOp',
  at: 1_764_000_000_000,
  via: 'mcp',
  kind: 'plan',
  explanation: '',
  explainedBy: 'fixed',
  input: { symbols: ['NVDAc'], budgetUsd: 100, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2 },
  plan: {
    legs: [{ symbol: 'NVDAc', name: 'NVIDIA', verdict: 'buy', reasons: [], gapBp: -2, gapAgainst: 'close', priceUsd: 150, depthUsd: 1e6, usd: 100, costBp: 3.4 }],
    budgetUsd: 100,
    plannedUsd: 100,
    session: { state: 'open', label: 'Open', nextOpenIso: '' },
    createdAt: 1_764_000_000_000,
  },
} as unknown as SavedStockPlan;

const fill = (over: Partial<SwapRecord> = {}): SwapRecord => ({
  hash: '0x' + '1'.repeat(64),
  at: saved.at + 2 * 3600_000,
  symbol: 'NVDAc',
  side: 'buy',
  usd: 100,
  feeBps: 0,
  feeUsd: 0,
  wallet: 'w',
  source: 'agent',
  planId: saved.id,
  // 0.6640 NVDAc (8 decimals): $100 / 0.664 = $150.60 per token.
  amountOut: '66400000',
  quotedOut: '66200000',
  minOut: '65869000',
  ...over,
});
const dec = () => 8;

describe('plan receipts', () => {
  it('sets what filled (the chain’s tokens) against the plan’s price, the quote, the signed minimum and the amount', () => {
    const [r] = planReceipts(saved, [fill()], dec);
    expect(r.tokens).toBeCloseTo(0.664, 9);
    expect(r.fillPriceUsd).toBeCloseTo(150.6024, 3);
    expect(r.vsPlanPriceBp).toBeCloseTo(40.2, 1); // paid 0.40% more per share than the plan's $150
    expect(r.vsQuoteBp).toBeCloseTo(30.2, 1); // 0.30% more tokens than quoted
    expect(r.metMinimum).toBe(true);
    expect(r.withinPlan).toBe(true);
    expect(r).toMatchObject({ plannedUsd: 100, plannedPriceUsd: 150, plannedCostBp: 3.4, costLimitBp: 30, afterPlanMs: 2 * 3600_000 });
  });
  it('prices per share with the token’s multiplier (1 token = multiplier shares)', () => {
    const [r] = planReceipts(saved, [fill()], dec, () => 1.004);
    expect(r.fillPriceUsd).toBeCloseTo(100 / (0.664 * 1.004), 6);
  });
  it('flags a fill over the plan’s amount, and leaves out other plans’ fills, sells and unreadable ones', () => {
    expect(planReceipts(saved, [fill({ usd: 120 })], dec)[0].withinPlan).toBe(false);
    expect(planReceipts(saved, [fill({ planId: 'ZzZzZzZzZzZzZzZz' }), fill({ side: 'sell' }), fill({ amountOut: undefined }), fill({ amountOut: '0' })], dec)).toEqual([]);
    // A swap someone built with this plan's id for a stock the plan never listed doesn't show.
    expect(planReceipts(saved, [fill({ symbol: 'AAPLc' })], dec)).toEqual([]);
    expect(planReceipts(saved, [fill()], () => undefined)).toEqual([]);
  });
  it('orders fills oldest first', () => {
    const rs = planReceipts(saved, [fill({ at: saved.at + 5000 }), fill({ at: saved.at + 1000 })], dec);
    expect(rs.map((r) => r.afterPlanMs)).toEqual([1000, 5000]);
  });
});
