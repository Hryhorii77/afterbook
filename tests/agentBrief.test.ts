import { describe, expect, it } from 'vitest';
import { buildBrief, parseBriefInput, type BriefInput } from '../lib/agent/brief';
import type { CostModel } from '../lib/agent/plan';
import type { SteadyDepth } from '../lib/market/depthSamples';
import type { TapeResult, TapeRow } from '../lib/market/tape';
import { STOCKS } from '../lib/stocks/tokens';
import { PROFILES } from '../lib/stocks/sectors';
import { BRIEF_LIMITS } from '../lib/agent/limits';
import { MAX_LEGS, MIN_LEGS, normalizeLegs } from '../lib/build/customBasket';
import { MAX_BASKET_USD, splitBasketUsdc } from '../lib/swap/basketBuy';

const NOW = 1_800_000_000_000;

const row = (symbol: string, over: Partial<TapeRow> = {}): TapeRow => ({
  symbol,
  cashTicker: symbol.replace(/c$/, ''),
  name: STOCKS.find((s) => s.symbol === symbol)?.name ?? symbol,
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

const tape = (rows: TapeRow[]): Pick<TapeResult, 'rows' | 'session'> => ({
  rows,
  session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-13', nextOpenIso: '2026-11-16T14:30:00.000Z' },
});

/** Every tracked stock, deep and fresh, unless overridden. */
const allRows = (over: Record<string, Partial<TapeRow>> = {}) => STOCKS.map((s) => row(s.symbol, over[s.symbol]));

const steadyOf = (depths: Record<string, number | null>, fallback: number | null = null) => {
  const m = new Map<string, SteadyDepth>();
  for (const s of STOCKS) {
    const usd = s.symbol in depths ? depths[s.symbol] : fallback;
    m.set(s.symbol, usd == null ? { usd: null, asOfMs: null, samples: 0, sinceMs: null } : { usd, asOfMs: NOW - 60_000, samples: 36, sinceMs: NOW - 3 * 3_600_000 });
  }
  return m;
};

/** 1 bp per $1,000 on top of a 5 bp fee. */
const linear: CostModel = { estimate: (u) => ({ sharesOut: u / 100, impactBp: 5 + u / 1000 }), sizeForImpact: (bp) => Math.max(0, (bp - 5) * 1000) };
const costsFor = (m: CostModel | null = linear) => new Map(STOCKS.map((s) => [s.symbol, m]));

const input = (over: Partial<BriefInput> = {}): BriefInput => ({
  theme: 'AI chips',
  exclude: [],
  minStocks: 3,
  budgetUsd: 1000,
  cashPct: 0,
  maxPremiumBp: 50,
  maxCostBp: 30,
  earningsDays: 2,
  note: '',
  ...over,
});

const run = (i: BriefInput, steady: Map<string, SteadyDepth>, rows = allRows(), costs = costsFor()) => buildBrief(i, tape(rows), steady, costs, NOW, 0, NOW);

describe('BRIEF_LIMITS', () => {
  it('match the basket buy it hands over to', () => {
    expect(BRIEF_LIMITS.maxBudgetUsd).toBe(MAX_BASKET_USD);
    expect(BRIEF_LIMITS.minStocks).toBe(MIN_LEGS);
    expect(BRIEF_LIMITS.maxStocks).toBe(MAX_LEGS);
  });
});

describe('parseBriefInput', () => {
  it('takes 2 to 4 stocks, whole numbers only; 2 is the minimum', () => {
    for (const n of [2, 3, 4]) expect(parseBriefInput({ budgetUsd: 100, minStocks: n })).toMatchObject({ minStocks: n });
    for (const n of [0, 1, 5, 2.5, 'x']) expect(typeof parseBriefInput({ budgetUsd: 100, minStocks: n })).toBe('string');
  });
  it('caps the budget at one basket buy ($25k) and cash at 50%', () => {
    expect(typeof parseBriefInput({ budgetUsd: 25_001 })).toBe('string');
    expect(parseBriefInput({ budgetUsd: 25_000 })).toMatchObject({ budgetUsd: 25_000 });
    expect(typeof parseBriefInput({ budgetUsd: 100, cashPct: 51 })).toBe('string');
  });
  it('accepts only the fixed themes and sectors', () => {
    expect(typeof parseBriefInput({ budgetUsd: 100, theme: 'robots that will moon' })).toBe('string');
    expect(typeof parseBriefInput({ budgetUsd: 100, exclude: ['Tobacco'] })).toBe('string');
    expect(parseBriefInput({ budgetUsd: 100 })).toMatchObject({ theme: 'Any', exclude: [], minStocks: 3, cashPct: 0 });
  });
});

describe('buildBrief', () => {
  it('picks at most 4, deepest steady pool first, ties by symbol, equal amounts', () => {
    // AI chips: NVDA, MU, AMD, AVGO, MRVL, SKHY, ARM. AMD and AVGO tie.
    const b = run(input({ minStocks: 4 }), steadyOf({ NVDAc: 1_400_000, MUc: 500_000, AMDc: 400_000, AVGOc: 400_000, MRVLc: 300_000, SKHYc: 60_000, ARMc: 60_000 }));
    expect(b.picks?.map((p) => p.symbol)).toEqual(['NVDAc', 'MUc', 'AMDc', 'AVGOc']);
    expect(b.picks?.map((p) => p.usd)).toEqual([250, 250, 250, 250]);
    expect(b.basket?.map((l) => l.weightPct)).toEqual([25, 25, 25, 25]);
    expect(b.dropped.find((d) => d.symbol === 'MRVLc')?.why).toMatch(/at most 4/);
    expect(b.dropped.find((d) => d.symbol === 'ARMc')?.why).toMatch(/as little as \$60,000/);
    expect(b.investedUsd).toBe(1000);
    expect(b.cashUsd).toBe(0);
    expect(b.picks?.every((p) => p.depthAsOfMs === NOW - 60_000)).toBe(true);
  });

  it('keeps the cash asked for, and never spends over the budget', () => {
    const b = run(input({ cashPct: 20, budgetUsd: 999 }), steadyOf({}, 1_000_000));
    expect(b.investedUsd).toBeLessThanOrEqual(999 * 0.8);
    expect(b.cashUsd).toBeCloseTo(999 - b.investedUsd, 2);
    expect(b.picks!.length).toBeLessThanOrEqual(4);
  });

  it('leaves out excluded sectors', () => {
    const b = run(input({ theme: 'Any', exclude: ['Information Technology'] }), steadyOf({}, 1_000_000));
    expect(b.picks?.some((p) => ['NVDAc', 'AAPLc', 'MSFTc', 'MSTRc'].includes(p.symbol))).toBe(false);
    expect(b.dropped.find((d) => d.symbol === 'NVDAc')?.why).toMatch(/left out/);
  });

  it('a stock with unknown depth is left out, not read live', () => {
    const b = run(input({ minStocks: 2 }), steadyOf({ NVDAc: null, MUc: 500_000, AMDc: 400_000 }, 0));
    expect(b.picks?.map((p) => p.symbol)).toEqual(['MUc', 'AMDc']);
    expect(b.dropped.find((d) => d.symbol === 'NVDAc')?.why).toMatch(/unknown/);
  });

  it('says plainly when Base can’t meet the brief, with no way out under 2', () => {
    const b = run(input({ theme: 'Health care' }), steadyOf({ HIMSc: 251_000 }, 50_000));
    expect(b.picks).toBeNull();
    expect(b.basket).toBeNull();
    expect(b.shortfall).toMatch(/Only 1 stock passes \(HIMS\)/);
    expect(b.suggestion).toBeNull();
    expect(b.cashUsd).toBe(1000);
    expect(b.steps.map((s) => s.symbols.length)).toEqual([3, 1, 1]); // HIMS, LLY, NVO
  });

  it('a theme with no deep pool gets no basket, never the deepest stocks of another theme', () => {
    const b = run(input({ theme: 'Health care', minStocks: 2 }), steadyOf({ HIMSc: 40_000, LLYc: 11_000, NVOc: 50_000 }, 2_000_000));
    expect(b.picks).toBeNull();
    expect(b.legs).toEqual([]);
    expect(b.shortfall).toMatch(/No stock on Base meets this brief/);
    expect(b.dropped.map((d) => d.symbol).sort()).toEqual(['HIMSc', 'LLYc', 'NVOc']);
    const allOut = run(input({ theme: 'Any', exclude: [...new Set(STOCKS.map((s) => PROFILES[s.symbol].sector))], minStocks: 2 }), steadyOf({}, 2_000_000));
    expect(allOut.picks).toBeNull();
    expect(allOut.legs).toEqual([]);
  });

  it('with no depth readings at all, says so instead of “no deep pools”', () => {
    const b = run(input({ theme: 'Any' }), steadyOf({}, null));
    expect(b.picks).toBeNull();
    expect(b.shortfall).toMatch(/no recent pool-depth readings/);
  });

  it('fewer than asked but at least 2: offers the smaller spread', () => {
    const b = run(input({ minStocks: 4 }), steadyOf({ NVDAc: 1_000_000, MUc: 500_000, AMDc: 400_000 }, 0));
    expect(b.picks).toBeNull();
    expect(b.suggestion).toEqual({ minStocks: 3, text: '3 passed. Spread over at least 3?' });
    const again = run(input({ minStocks: 3 }), steadyOf({ NVDAc: 1_000_000, MUc: 500_000, AMDc: 400_000 }, 0));
    expect(again.picks?.length).toBe(3);
  });

  it('a stock that fails the price limit is dropped with the plan’s reason', () => {
    const rows = allRows({ NVDAc: { basisBp: 120, onchainMidUsd: 101.2 } });
    const b = run(input({ minStocks: 2 }), steadyOf({ NVDAc: 1_000_000, MUc: 500_000, AMDc: 400_000 }, 0), rows);
    expect(b.picks?.map((p) => p.symbol)).toEqual(['MUc', 'AMDc']);
    expect(b.dropped.find((d) => d.symbol === 'NVDAc')?.why).toMatch(/more than the/);
  });

  it('shows and sizes on the steady depth when it is lower than the live read', () => {
    // Live reads say $2M; steady says $300k. (The 10%-of-pool cap can't bite here: the floor is $250k,
    // so 10% is at least $25k, and a $25k budget over 2+ stocks is at most $12.5k each.)
    const b = run(input({ minStocks: 2, budgetUsd: 25_000, maxCostBp: 200 }), steadyOf({ NVDAc: 300_000, MUc: 1_000_000 }, 0));
    const nv = b.picks!.find((p) => p.symbol === 'NVDAc')!;
    expect(nv.depthUsd).toBe(300_000);
    expect(nv.usd).toBeLessThanOrEqual(12_500);
  });

  it('a leg shrunk by the cost limit leaves its money as cash', () => {
    const b = run(input({ minStocks: 2, budgetUsd: 20_000, maxCostBp: 10 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_000_000 }, 0));
    expect(b.picks!.every((p) => p.costBp <= 10)).toBe(true);
    expect(b.investedUsd).toBeLessThan(20_000);
    expect(b.cashUsd).toBeCloseTo(20_000 - b.investedUsd, 2);
    expect(b.basket!.reduce((s, l) => s + l.weightPct, 0)).toBe(100);
  });

  it('shows exactly what the basket buy will split, never more per stock than it was sized for', () => {
    // $25k over 3: sized $8,333 each; whole percents are 34/33/33.
    const b = run(input({ minStocks: 3, budgetUsd: 25_000, maxCostBp: 200 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0));
    expect(b.basket!.map((l) => l.weightPct)).toEqual([34, 33, 33]);
    const split = splitBasketUsdc(BigInt(Math.round(b.investedUsd * 1e6)), b.basket!);
    for (const p of b.picks!) {
      expect(p.usd).toBeLessThanOrEqual(8_333);
      const leg = Number(split.find((x) => x.symbol === p.symbol)!.amountIn) / 1e6;
      expect(Math.abs(leg - p.usd)).toBeLessThan(0.02);
    }
    expect(b.cashUsd).toBeCloseTo(25_000 - b.investedUsd, 2);
  });

  it('a stock too small to be a whole percent is dropped with its reason, not silently', () => {
    // NVDA's cost model only allows a tiny buy; MU and AMD take $12,000+ each.
    const costs = costsFor();
    costs.set('NVDAc', { estimate: (u) => ({ sharesOut: u / 100, impactBp: u <= 50 ? 5 : 500 }), sizeForImpact: () => 50 });
    const b = run(input({ minStocks: 2, budgetUsd: 25_000, maxCostBp: 200 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0), allRows(), costs);
    expect(b.picks!.map((p) => p.symbol)).toEqual(['MUc', 'AMDc']);
    expect(b.basket!.map((l) => l.symbol)).toEqual(['MUc', 'AMDc']);
    expect(b.dropped.find((d) => d.symbol === 'NVDAc')?.why).toMatch(/under 1% of the basket/);
  });

  it('never shows a stock under the $10 swap minimum after the split', () => {
    // Sized $10 / $702 / $10 → whole percents 2/97/1 would cut one to $5: it is dropped with its reason.
    const costs = costsFor();
    const capAt = (max: number): CostModel => ({ estimate: (u) => ({ sharesOut: u / 100, impactBp: u <= max ? 5 : 500 }), sizeForImpact: () => max / 0.98 });
    costs.set('NVDAc', capAt(10.5));
    costs.set('MUc', capAt(702.5));
    costs.set('AMDc', capAt(10.5));
    const b = run(input({ minStocks: 2, budgetUsd: 3_000, maxCostBp: 200 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0), allRows(), costs);
    for (const p of b.picks ?? []) expect(p.usd).toBeGreaterThanOrEqual(10);
    expect(b.dropped.some((d) => /minimum for a swap/.test(d.why))).toBe(true);
  });

  it('whole-percent weights always add up to 100 (5/5/3/3 used to give 31/31/19/18)', () => {
    const legs = (w: number[]) => normalizeLegs(w.map((weight, i) => ({ symbol: `S${i}`, weight })));
    expect(legs([5, 5, 3, 3]).map((l) => l.weightPct)).toEqual([31, 31, 19, 19]);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const w = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => 1 + rnd() * 10_000);
      expect(legs(w).reduce((a, l) => a + l.weightPct, 0)).toBe(100);
    }
  });

  it('fuzz: every pick is exactly what the basket buy splits, never more than it was sized for', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 400; i++) {
      const caps = new Map(STOCKS.map((s) => [s.symbol, 10 + rnd() * 9_000] as const));
      const costs = new Map(
        STOCKS.map((s) => [s.symbol, { estimate: (u: number) => ({ sharesOut: u / 100, impactBp: u <= caps.get(s.symbol)! ? 5 : 500 }), sizeForImpact: () => caps.get(s.symbol)! } as CostModel]),
      );
      const budget = 10 + Math.floor(rnd() * 24_990);
      const b = run(input({ theme: 'Any', minStocks: 2, budgetUsd: budget, cashPct: Math.floor(rnd() * 30), maxCostBp: 200 }), steadyOf({}, 2_000_000), allRows(), costs);
      if (!b.picks) continue;
      expect(b.basket!.reduce((a, l) => a + l.weightPct, 0)).toBe(100);
      const split = splitBasketUsdc(BigInt(Math.round(b.investedUsd * 1e6)), b.basket!);
      for (const p of b.picks) {
        const leg = Number(split.find((x) => x.symbol === p.symbol)!.amountIn) / 1e6;
        expect(Math.abs(leg - p.usd)).toBeLessThan(0.011);
        expect(p.usd).toBeGreaterThanOrEqual(10);
        expect(p.usd).toBeLessThanOrEqual(caps.get(p.symbol)! + 0.01);
      }
      expect(b.investedUsd + b.cashUsd).toBeCloseTo(budget, 2);
    }
  });

  it('a small budget takes fewer stocks instead of “nothing meets this”', () => {
    const steady = steadyOf({}, 2_000_000);
    const two = run(input({ theme: 'Any', minStocks: 2, budgetUsd: 20 }), steady);
    expect(two.picks?.map((p) => p.usd)).toEqual([10, 10]);
    const short = run(input({ theme: 'Any', minStocks: 3, budgetUsd: 25 }), steady);
    expect(short.picks).toBeNull();
    expect(short.shortfall).toMatch(/too little for at least \$10 in each of 3 stocks/);
    expect(short.suggestion).toEqual({ minStocks: 2, text: '2 passed. Spread over at least 2?' });
  });

  it('a stock the cost limit drops gives its share to the others', () => {
    const costs = costsFor();
    costs.set('NVDAc', { estimate: () => ({ sharesOut: 1, impactBp: 500 }), sizeForImpact: () => 1 });
    const b = run(input({ minStocks: 2, budgetUsd: 900 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0), allRows(), costs);
    expect(b.picks?.map((p) => p.symbol)).toEqual(['MUc', 'AMDc']);
    expect(b.investedUsd).toBe(900);
    expect(b.dropped.find((d) => d.symbol === 'NVDAc')?.why).toMatch(/cost/);
  });

  it('no basket when sizing drops a leg below the spread asked for', () => {
    const costs = costsFor();
    costs.set('MUc', null); // liquidity unreadable
    const b = run(input({ minStocks: 2 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_000_000 }, 0), allRows(), costs);
    expect(b.picks).toBeNull();
    expect(b.shortfall).toMatch(/Only 1 stock passes \(NVDA\)/);
  });
});
