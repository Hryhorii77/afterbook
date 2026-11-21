import { describe, expect, it } from 'vitest';
import type { PlanLeg } from '../lib/agent/plan';
import type { Brief } from '../lib/agent/brief';
import { isSavedPlan, savedBuys, recheckInput, cappedBuys, basketRecheck, type SavedStockPlan, type SavedBasket } from '../lib/agent/planLink';

// An agent's saved plan link (/plan/<id>): what the page may offer after the checks run again.
const leg = (symbol: string, verdict: PlanLeg['verdict'], usd?: number, extra: Partial<PlanLeg> = {}): PlanLeg => ({
  symbol, name: symbol, verdict, reasons: verdict === 'buy' ? ['ok'] : ['why'], decidedBy: verdict === 'buy' ? undefined : 'why',
  gapBp: 10, gapAgainst: 'price', priceUsd: 100, depthUsd: 5e6, ...(usd != null ? { usd } : {}), ...extra,
});
const base = { v: 1 as const, id: 'AbCdEfGhIjKlMnOp', at: 1, via: 'x402' as const, explanation: 'x', explainedBy: 'fixed' as const };
const limits = { maxPremiumBp: 40, maxCostBp: 25, earningsDays: 7 };
const stockPlan: SavedStockPlan = {
  ...base,
  kind: 'plan',
  input: { symbols: [], budgetUsd: 1500, ...limits },
  plan: { legs: [leg('NVDAc', 'buy', 500), leg('MUc', 'buy', 500), leg('AMDc', 'wait')], budgetUsd: 1500, plannedUsd: 1000, session: { state: 'open', label: 'Open', nextOpenIso: '' }, createdAt: 1 },
};
const basket: SavedBasket = {
  ...base,
  kind: 'basket',
  brief: {
    input: { theme: 'AI chips', exclude: [], minStocks: 2, budgetUsd: 1000, cashPct: 0, ...limits },
    basket: [
      { symbol: 'NVDAc', weightPct: 60 },
      { symbol: 'MUc', weightPct: 40 },
    ],
    investedUsd: 900,
  } as unknown as Brief,
};

describe('saved plan links', () => {
  it('reads back only a well-formed record', () => {
    expect(isSavedPlan(stockPlan)).toBe(true);
    expect(isSavedPlan(basket)).toBe(true);
    expect(isSavedPlan({ ...stockPlan, id: 'short' })).toBe(false);
    expect(isSavedPlan({ ...stockPlan, via: 'web' })).toBe(false);
    expect(isSavedPlan({ ...stockPlan, plan: { legs: 'x' } })).toBe(false);
    expect(isSavedPlan({ ...basket, kind: 'other' })).toBe(false);
    expect(isSavedPlan(null)).toBe(false);
  });

  it('rechecks only the stocks the plan said to buy, with the same limits', () => {
    expect([...savedBuys(stockPlan)]).toEqual([['NVDAc', 500], ['MUc', 500]]);
    expect(recheckInput(stockPlan)).toEqual({ symbols: ['NVDAc', 'MUc'], budgetUsd: 1500, ...limits, note: '' });
    expect([...savedBuys(basket)]).toEqual([['NVDAc', 540], ['MUc', 360]]);
    expect(recheckInput(basket)).toEqual({ symbols: ['NVDAc', 'MUc'], budgetUsd: 900, ...limits, note: '' });
    const none = { ...stockPlan, plan: { ...stockPlan.plan, legs: [leg('AMDc', 'skip')] } };
    expect(recheckInput(none)).toBeNull();
  });

  it('offers what still passes, never over the saved amount, nothing under the minimum', () => {
    const fresh = [leg('NVDAc', 'buy', 800), leg('MUc', 'buy', 320), leg('AMDc', 'buy', 900)];
    // AMDc was a wait in the saved plan: no amount was ever shown for it, so it is not offered.
    expect(cappedBuys(stockPlan, fresh)).toEqual([{ symbol: 'NVDAc', usd: 500 }, { symbol: 'MUc', usd: 320, wasUsd: 500 }]);
    expect(cappedBuys(stockPlan, [leg('NVDAc', 'wait'), leg('MUc', 'buy', 9)])).toEqual([]);
  });

  it('never offers a new listing (AUTO_PICK_HOLD) from a link, even one the agent named', () => {
    const withNew = { ...stockPlan, plan: { ...stockPlan.plan, legs: [leg('NVDAc', 'buy', 500), leg('ANTc', 'buy', 500)] } };
    expect(cappedBuys(withNew, [leg('NVDAc', 'buy', 500), leg('ANTc', 'buy', 500)])).toEqual([{ symbol: 'NVDAc', usd: 500 }]);
    const newBasket = { ...basket, brief: { ...basket.brief, basket: [{ symbol: 'NVDAc', weightPct: 50 }, { symbol: 'ANTc', weightPct: 50 }] } as Brief };
    expect(basketRecheck(newBasket, [leg('NVDAc', 'buy', 450), leg('ANTc', 'buy', 450)])).toEqual({ ok: false, why: ['ANTc: a new listing, not offered from an agent’s link.'] });
  });

  it('a basket is offered whole, at its saved total, or not at all', () => {
    expect(basketRecheck(basket, [leg('NVDAc', 'buy', 540), leg('MUc', 'buy', 360)])).toEqual({ ok: true, usd: 900 });
    const cut = basketRecheck(basket, [leg('NVDAc', 'buy', 400, { cutBy: 'cost limit' }), leg('MUc', 'buy', 360)]);
    expect(cut).toEqual({ ok: false, why: ['NVDAc: its full share no longer fits your cost limit.'] });
    const waits = basketRecheck(basket, [leg('NVDAc', 'buy', 540), leg('MUc', 'wait')]);
    expect(waits).toEqual({ ok: false, why: ['MUc: why'] });
    expect(basketRecheck(basket, [leg('NVDAc', 'buy', 540)]).ok).toBe(false);
  });
});
