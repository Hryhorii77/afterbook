import { describe, expect, it } from 'vitest';
import { parsePlanInput, screen, sizeLegs, summarize, fallbackExplanation, type CostModel, type PlanInput } from '../lib/agent/plan';
import type { TapeResult, TapeRow } from '../lib/market/tape';

const row = (over: Partial<TapeRow>): TapeRow => ({
  symbol: 'NVDAc',
  cashTicker: 'NVDA',
  name: 'NVIDIA Corporation',
  cashLastUsd: 100,
  cashAsOfMs: 0,
  cashPriceType: 'regular',
  cashStale: false,
  closeUsd: 100,
  closeAsOfMs: 0,
  onchainMidUsd: 100.2,
  tick: 0,
  basisBp: 20,
  depthUsd: 2_000_000,
  depthShares: 20_000,
  multiplier: 1,
  nextEarningsDate: null,
  ...over,
});

const session = (state: TapeResult['session']['state']): TapeResult['session'] => ({
  state,
  label: state === 'open' ? 'Open' : 'Weekend',
  nyTime: '10:00',
  dateKey: '2026-11-09',
  nextOpenIso: '2026-11-09T14:30:00.000Z',
});

const input = (over: Partial<PlanInput> = {}): PlanInput => ({ symbols: [], budgetUsd: 1000, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2, note: '', ...over });

/** Cost grows 1 bp per $1,000 on top of a 5 bp fee. */
const linear: CostModel = {
  estimate: (usd) => ({ sharesOut: usd / 100, impactBp: 5 + usd / 1000 }),
  sizeForImpact: (bp) => Math.max(0, (bp - 5) * 1000),
};

describe('parsePlanInput', () => {
  const known = (s: string) => ['NVDAc', 'AAPLc'].includes(s);
  it('fills defaults and drops duplicate symbols', () => {
    expect(parsePlanInput({ symbols: ['NVDAc', 'NVDAc'], budgetUsd: '500' }, known)).toEqual({
      symbols: ['NVDAc'], budgetUsd: 500, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2, note: '',
    });
  });
  it('refuses unknown symbols, out-of-range numbers and long notes', () => {
    expect(parsePlanInput({ symbols: ['XYZc'], budgetUsd: 500 }, known)).toMatch(/unknown symbol/);
    expect(parsePlanInput({ budgetUsd: 5 }, known)).toBe('the budget must be between $10 and $100,000');
    expect(parsePlanInput({ budgetUsd: 500, maxCostBp: 0 }, known)).toMatch(/^the most you'll pay to trade/);
    expect(parsePlanInput({ budgetUsd: 500, note: 'x'.repeat(281) }, known)).toBe('the note must be at most 280 characters');
    expect(parsePlanInput(null, known)).toMatch(/JSON object/);
  });
});

describe('screen', () => {
  it('waits when the premium is over the limit and passes when under', () => {
    const tape = { rows: [row({ symbol: 'NVDAc', basisBp: 80 }), row({ symbol: 'AAPLc', cashTicker: 'AAPL', basisBp: 10 })], session: session('open') };
    const legs = screen(input({ symbols: ['NVDAc', 'AAPLc'] }), tape);
    expect(legs.map((l) => l.verdict)).toEqual(['wait', 'buy']);
    expect(legs[0].reasons[0]).toMatch(/more than the 0.50%/);
  });
  it('waits before earnings inside the window, ignores them at 0 days', () => {
    const tape = { rows: [row({ nextEarningsDate: '2026-11-10' })], session: session('open') };
    expect(screen(input({ symbols: ['NVDAc'] }), tape)[0].verdict).toBe('wait');
    expect(screen(input({ symbols: ['NVDAc'], earningsDays: 0 }), tape)[0].verdict).toBe('buy');
  });
  it('waits on a gap over 3% either way, discounts included', () => {
    const tape = { rows: [row({ basisBp: -900 })], session: session('open') };
    const [leg] = screen(input({ symbols: ['NVDAc'] }), tape);
    expect(leg.verdict).toBe('wait');
    expect(leg.reasons[0]).toMatch(/below the cash price, over 3.0% \(300.0 bp\) either way: the pool’s price may be stale/);
  });
  it('says no earnings report is due only after a full calendar scan in the last 36 hours', () => {
    const tape = { rows: [row({ nextEarningsDate: null })], session: session('open') };
    const now = 1_800_000_000_000;
    const [fresh] = screen(input({ symbols: ['NVDAc'] }), tape, now - 20 * 3_600_000, now);
    expect(fresh.verdict).toBe('buy');
    expect(fresh.reasons.join(' ')).toMatch(/NVDA has no earnings report on the calendar in the next 14 days\./);
    // A stale scan, or none on record (a failed day keeps the time from moving): absence proves nothing.
    for (const syncedAt of [now - 40 * 3_600_000, null]) {
      const [leg] = screen(input({ symbols: ['NVDAc'] }), tape, syncedAt, now);
      expect(leg.reasons.join(' ')).toMatch(/Couldn’t confirm NVDA’s earnings date: the calendar wasn’t fully checked in the last 36 hours\. Check it before buying\./);
    }
    const [ignored] = screen(input({ symbols: ['NVDAc'], earningsDays: 0 }), tape, null, now);
    expect(ignored.reasons.join(' ')).not.toMatch(/earnings/);
  });
  it('skips thin pools and stale prices', () => {
    const tape = { rows: [row({ depthUsd: 100_000 }), row({ symbol: 'AAPLc', cashStale: true })], session: session('open') };
    expect(screen(input({ symbols: ['NVDAc', 'AAPLc'] }), tape).map((l) => l.verdict)).toEqual(['skip', 'skip']);
  });
  it('measures against the close while cash is closed, and the explanation says so', () => {
    const tape = { rows: [row({ basisBp: 5, closeUsd: 99, onchainMidUsd: 100 })], session: session('closed-weekend') };
    const [leg] = screen(input({ symbols: ['NVDAc'] }), tape);
    expect(leg.gapAgainst).toBe('close');
    expect(leg.gapBp).toBeCloseTo(101, 0);
    expect(leg.verdict).toBe('wait');
    expect(fallbackExplanation(summarize([leg], input(), tape.session))).toMatch(/market is closed, so each gap is against the last close/);
  });
  it('picks the deepest fresh pools when no stock is chosen', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ symbol: `S${i}c`, depthUsd: 300_000 + i * 100_000 }));
    expect(screen(input(), { rows, session: session('open') }).map((l) => l.symbol)).toEqual(['S7c', 'S6c', 'S5c', 'S4c', 'S3c']);
  });
});

describe('sizeLegs', () => {
  const tape = { rows: [row({}), row({ symbol: 'AAPLc', cashTicker: 'AAPL', depthUsd: 50_000_000 })], session: session('open') };
  it('splits the budget equally when costs fit', () => {
    const legs = sizeLegs(screen(input({ symbols: ['NVDAc', 'AAPLc'] }), tape), input(), new Map([['NVDAc', linear], ['AAPLc', linear]]));
    expect(legs.map((l) => l.usd)).toEqual([500, 500]);
    expect(legs[0].costBp).toBeCloseTo(5.5);
  });
  it('sizes down to the cost limit, within 10% of the pool and $25k', () => {
    const big = input({ symbols: ['NVDAc', 'AAPLc'], budgetUsd: 100_000, maxCostBp: 20 });
    const legs = sizeLegs(screen(big, tape), big, new Map([['NVDAc', linear], ['AAPLc', linear]]));
    // $50k asked for each; the swap cap is $25k and 10% of each pool is more, so the 20 bp cost limit decides (~$14.7k).
    for (const l of legs) {
      expect(l.verdict).toBe('buy');
      expect(l.usd!).toBeLessThanOrEqual(15_000);
      expect(l.costBp!).toBeLessThanOrEqual(20);
      expect(l.reasons.join(' ')).toMatch(/Sized down/);
    }
  });
  it('caps at $25k per swap', () => {
    const big = input({ symbols: ['AAPLc'], budgetUsd: 60_000, maxCostBp: 200 });
    const [leg] = sizeLegs(screen(big, tape), big, new Map([['AAPLc', linear]]));
    expect(leg.usd).toBe(25_000);
    expect(leg.reasons.join(' ')).toMatch(/Capped at \$25,000/);
  });
  it('skips when the cost model is missing or even the minimum is too dear', () => {
    const steep: CostModel = { estimate: () => ({ sharesOut: 1, impactBp: 500 }), sizeForImpact: () => 1 };
    const legs = sizeLegs(screen(input({ symbols: ['NVDAc', 'AAPLc'] }), tape), input(), new Map([['NVDAc', null], ['AAPLc', steep]]));
    expect(legs.map((l) => l.verdict)).toEqual(['skip', 'skip']);
  });
  it('records the reason that decided a skip, not a warning listed before it (live, 2026-11-08)', () => {
    const tiny = input({ symbols: ['NVDAc', 'AAPLc'], budgetUsd: 10 });
    const legs = sizeLegs(screen(tiny, tape), tiny, new Map([['NVDAc', linear], ['AAPLc', linear]]));
    expect(legs[0].reasons.some((r) => r.startsWith('Couldn’t confirm'))).toBe(true);
    expect(legs[0].decidedBy).toMatch(/^Your \$10 split over 2 stocks/);
  });
  it('keeps the first blocking reason when a wait also has earnings inside the window', () => {
    const t = { rows: [row({ basisBp: 80, nextEarningsDate: '2026-11-10' })], session: session('open') };
    const [leg] = screen(input({ symbols: ['NVDAc'] }), t);
    expect(leg.verdict).toBe('wait');
    expect(leg.decidedBy).toMatch(/more than the 0\.50%/);
    expect(leg.reasons.at(-1)).toMatch(/reports earnings tomorrow/);
  });
  it('leaves decidedBy unset on a buy', () => {
    const [leg] = sizeLegs(screen(input({ symbols: ['NVDAc'] }), tape), input(), new Map([['NVDAc', linear]]));
    expect(leg.verdict).toBe('buy');
    expect(leg.decidedBy).toBeUndefined();
  });
  it('gives the real reason when the budget split is under the $10 minimum', () => {
    const tiny = input({ symbols: ['NVDAc', 'AAPLc'], budgetUsd: 10 });
    const legs = sizeLegs(screen(tiny, tape), tiny, new Map([['NVDAc', linear], ['AAPLc', linear]]));
    expect(legs.map((l) => l.verdict)).toEqual(['skip', 'skip']);
    expect(legs[0].reasons.at(-1)).toBe('Your $10 split over 2 stocks is $5.00 each, under the $10 minimum for a swap. Pick fewer stocks or raise the budget.');
  });
  it('counts Afterbook’s swap fee in the cost and the sizing', () => {
    const one = input({ symbols: ['NVDAc'], budgetUsd: 50_000, maxCostBp: 20 });
    const [leg] = sizeLegs(screen(one, tape), one, new Map([['NVDAc', linear]]), 10);
    // Pool cost may use only 20 - 10 = 10 bp: at most ~$5k.
    expect(leg.usd!).toBeLessThanOrEqual(5_000);
    expect(leg.costBp!).toBeLessThanOrEqual(20);
    expect(leg.reasons.join(' ')).toMatch(/plus Afterbook’s 10 bp fee/);
    const [over] = sizeLegs(screen(one, tape), { ...one, maxCostBp: 10 }, new Map([['NVDAc', linear]]), 10);
    expect(over.verdict).toBe('skip');
  });
  it('summarizes and explains without Claude', () => {
    const legs = sizeLegs(screen(input({ symbols: ['NVDAc'] }), tape), input(), new Map([['NVDAc', linear]]));
    const plan = summarize(legs, input(), tape.session, 1);
    expect(plan.plannedUsd).toBe(1000);
    expect(fallbackExplanation(plan)).toMatch(/One buy passes your limits: NVDAc \$1,000/);
  });
});

describe('isLoggedPlan', () => {
  it('accepts a saved plan and rejects broken entries', async () => {
    const { isLoggedPlan } = await import('../lib/agent/planLog');
    const ok = { at: 1, budgetUsd: 100, explainedBy: 'fixed', legs: [{ symbol: 'NVDAc', verdict: 'buy', usd: 50, priceUsd: 100 }] };
    expect(isLoggedPlan(ok)).toBe(true);
    expect(isLoggedPlan(null)).toBe(false);
    expect(isLoggedPlan({ ...ok, legs: 'x' })).toBe(false);
    expect(isLoggedPlan({ ...ok, legs: [{ symbol: 'NVDAc', verdict: 'maybe', priceUsd: 1 }] })).toBe(false);
    expect(isLoggedPlan({ ...ok, legs: [null] })).toBe(false);
    expect(isLoggedPlan({ ...ok, at: 'today' })).toBe(false);
  });
});
