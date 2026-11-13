import { describe, expect, it } from 'vitest';
import { briefShortlist, buildBrief, parseBriefInput, type BriefInput } from '../lib/agent/brief';
import { briefFacts, numbersAllowed } from '../lib/agent/explain';
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
  it('a missing limit takes its default; an explicit null (NaN or Infinity from the page) is refused', () => {
    expect(parseBriefInput({ budgetUsd: 100 })).toMatchObject({ maxCostBp: 30, maxPremiumBp: 50, cashPct: 0, minStocks: 3, earningsDays: 2 });
    for (const k of ['maxCostBp', 'maxPremiumBp', 'cashPct', 'minStocks', 'earningsDays'])
      expect(typeof parseBriefInput({ budgetUsd: 100, [k]: null }), k).toBe('string');
    expect(parseBriefInput(JSON.parse(JSON.stringify({ budgetUsd: 100, maxCostBp: Infinity })))).toMatch(/most to pay to trade/);
  });
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
    // The returned legs say what was sized, not the unsized shortlist.
    expect(b.legs.filter((l) => l.verdict === 'buy').map((l) => l.usd)).toEqual([250, 250, 250, 250]);
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

  it('$30 over 3 is a budget problem (34/33/33 cuts two under $10), and cents survive', () => {
    const steady = steadyOf({}, 2_000_000);
    const b = run(input({ theme: 'Any', minStocks: 3, budgetUsd: 30 }), steady);
    expect(b.picks).toBeNull();
    expect(b.shortfall).toMatch(/too little for at least \$10 in each of 3 stocks/);
    expect(b.suggestion?.minStocks).toBe(2);
    const c = run(input({ theme: 'Any', minStocks: 2, budgetUsd: 19.99 }), steady);
    expect(c.picks?.length).toBeUndefined(); // $19.99 can't make two $10 legs
    const d = run(input({ theme: 'Any', minStocks: 2, budgetUsd: 20.01 }), steady);
    expect(d.picks?.map((p) => p.usd)).toEqual([10, 10]);
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

  it('counts every stock that passed, then the cut to the 4 deepest as its own step', () => {
    const b = run(input({ minStocks: 4 }), steadyOf({ NVDAc: 1_400_000, MUc: 500_000, AMDc: 400_000, AVGOc: 400_000, MRVLc: 300_000, SKHYc: 60_000, ARMc: 60_000 }));
    expect(b.steps.map((s) => [s.symbols.length, s.label])).toEqual([
      [7, 'Theme “AI chips”: stocks on Afterbook'],
      [5, 'with a pool over $250,000 in every reading of the last 3 hours'],
      [5, 'that pass your price and earnings limits'],
      [4, 'the 4 with the deepest pools (a basket holds at most 4)'],
    ]);
    // A cut by the cost limit is a step of its own too.
    const costs = costsFor();
    costs.set('NVDAc', { estimate: () => ({ sharesOut: 1, impactBp: 500 }), sizeForImpact: () => 1 });
    const c = run(input({ minStocks: 2, budgetUsd: 900 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0), allRows(), costs);
    expect(c.steps.map((s) => s.symbols.length)).toEqual([7, 3, 3, 2]);
    expect(c.steps[3].label).toMatch(/cost limit/);
  });

  it('Claude gets each dropped stock’s name, and why the cash is more than asked', () => {
    const b = run(input({ cashPct: 10 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000, SKHYc: 60_000 }, 0));
    expect(b.basket?.map((l) => l.weightPct)).toEqual([34, 33, 33]);
    const f = briefFacts(b);
    expect(f.dropped.find((d) => d.symbol === 'SKHYc')?.name).toBe('SK hynix Inc.');
    expect(f.cashWhy).toBe(`You asked to keep $100 as cash, and $${b.cashUsd.toLocaleString('en-US')} stays as cash because the weights are whole percents and the amount is rounded down to whole dollars, so no stock gets more than it was sized for.`);
    expect(b.picks?.every((p) => p.sizedDownBy === null)).toBe(true);
    expect(briefFacts(run(input({ cashPct: 10, minStocks: 4 }), steadyOf({}, 2_000_000))).cashWhy).toBeNull();
  });

  it('cash left by a cost-limit cut is blamed on the cost limit, not the weights', () => {
    // NVDA fills over the limit above $100: sized down to $98 (0.98 of the size that fits).
    const costs = costsFor();
    costs.set('NVDAc', { estimate: (u: number) => ({ sharesOut: u / 100, impactBp: u > 100 ? 500 : 10 }), sizeForImpact: () => 100 });
    const b = run(input({ minStocks: 4 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000, AVGOc: 900_000 }, 0), allRows(), costs);
    const nvda = b.picks?.find((p) => p.symbol === 'NVDAc');
    expect(nvda?.sizedDownBy).toBe('cost limit');
    expect(b.picks?.filter((p) => p.symbol !== 'NVDAc').every((p) => p.sizedDownBy === null)).toBe(true);
    const why = briefFacts(b).cashWhy!;
    expect(why).toMatch(new RegExp(`^You kept no cash aside, but \\$${b.cashUsd} stays as cash because your cost limit cut NVDA to \\$${nvda!.usd}`));
    expect(why).not.toMatch(/whole percents/);
    expect(why).toMatch(/what that stock couldn’t take/);
    expect(numbersAllowed(why, briefFacts(b))).toBe(true);
  });

  it('a sentence naming several cut stocks passes the number check (commas after amounts)', () => {
    const costs = costsFor();
    const capAt = (limit: number): CostModel => ({ estimate: (u: number) => ({ sharesOut: u / 100, impactBp: u > limit ? 500 : 10 }), sizeForImpact: () => limit });
    costs.set('NVDAc', capAt(100));
    costs.set('MUc', capAt(150));
    costs.set('AMDc', capAt(200));
    const b = run(input({ minStocks: 4 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000, AVGOc: 900_000 }, 0), allRows(), costs);
    expect(b.picks?.filter((p) => p.sizedDownBy === 'cost limit').map((p) => p.symbol)).toEqual(['NVDAc', 'MUc', 'AMDc']);
    const why = briefFacts(b).cashWhy!;
    expect(why).toMatch(/cut NVDA to \$\d+(\.\d+)?, MU to \$\d+(\.\d+)? and AMD to \$\d+(\.\d+)?, and what those stocks/);
    expect(numbersAllowed(why, briefFacts(b))).toBe(true);
    // Claude rewording it with commas after the amounts passes too.
    const [n, m] = b.picks!.filter((p) => p.sizedDownBy).map((p) => p.usd);
    expect(numbersAllowed(`Your cost limit cut NVDA to $${n}, MU to $${m}, and the rest stays as cash.`, briefFacts(b))).toBe(true);
  });

  it('sizeLegs marks a cut leg itself, so a reworded reason can’t break sizedDownBy', () => {
    const costs = costsFor();
    costs.set('NVDAc', { estimate: (u: number) => ({ sharesOut: u / 100, impactBp: u > 100 ? 500 : 10 }), sizeForImpact: () => 100 });
    const b = run(input({ minStocks: 4 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000, AVGOc: 900_000 }, 0), allRows(), costs);
    expect(b.legs.find((l) => l.symbol === 'NVDAc')?.cutBy).toBe('cost limit');
    expect(b.legs.filter((l) => l.symbol !== 'NVDAc' && l.verdict === 'buy').every((l) => l.cutBy === undefined)).toBe(true);
  });
});

describe('refilling the basket', () => {
  const over: CostModel = { estimate: (u: number) => ({ sharesOut: u / 100, impactBp: 500 }), sizeForImpact: () => 1 };
  const aiChips = { NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000, AVGOc: 900_000, MRVLc: 800_000, SKHYc: 60_000, ARMc: 60_000 };

  it('a stock the cost limit drops is replaced by the next deepest that passed', () => {
    const costs = costsFor();
    costs.set('NVDAc', over);
    const b = run(input({ minStocks: 4 }), steadyOf(aiChips, 0), allRows(), costs);
    expect(b.picks?.map((p) => p.symbol)).toEqual(['MUc', 'AMDc', 'AVGOc', 'MRVLc']);
    expect(b.picks?.map((p) => p.usd)).toEqual([250, 250, 250, 250]);
    expect(b.dropped.find((d) => d.symbol === 'NVDAc')?.why).toMatch(/cost more than your/);
    expect(b.dropped.some((d) => d.symbol === 'MRVLc')).toBe(false);
    expect(b.steps.map((s) => [s.symbols.length, s.label])).toEqual([
      [7, 'Theme “AI chips”: stocks on Afterbook'],
      [5, 'with a pool over $250,000 in every reading of the last 3 hours'],
      [5, 'that pass your price and earnings limits'],
      [4, 'within your cost limit'],
    ]);
  });

  it('when the cost limit drops every stock, it says so instead of “no stock meets this brief”', () => {
    const b = run(input({ minStocks: 2 }), steadyOf(aiChips, 0), allRows(), costsFor(over));
    expect(b.picks).toBeNull();
    expect(b.shortfall).toBe(
      'Your 0.3% limit on what you’ll pay to trade leaves out every stock it was tried on (NVDA, MU, AMD, AVGO, MRVL): even a $10 buy in each would cost more than that. A higher limit lets more through.',
    );
    expect(b.shortfall).not.toMatch(/No stock on Base/);
    expect(b.steps.at(-1)).toMatchObject({ label: 'within your cost limit', symbols: [] });
  });

  it('too few left after the cost limit: names what it left out', () => {
    const costs = costsFor();
    costs.set('NVDAc', over);
    costs.set('MUc', over);
    const b = run(input({ minStocks: 2 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0), allRows(), costs);
    expect(b.shortfall).toBe('Only 1 stock passes (AMD), your 0.3% cost limit left out NVDA, MU, and you asked to spread over at least 2, so there is no basket.');
    expect(b.suggestion).toBeNull();
  });

  it('builds only from the stocks the route read cost models for, and lists every other one once', () => {
    const steady = steadyOf({}, 2_000_000); // every stock deep: Any theme, ties by symbol
    const i = input({ theme: 'Any', minStocks: 4 });
    const short = briefShortlist(i, tape(allRows()), steady, NOW, NOW);
    expect(short).toHaveLength(BRIEF_LIMITS.maxCandidates);
    // As the route does: cost models for the shortlist only. The 4 deepest are over the limit.
    const costs = new Map<string, CostModel | null>(short.map((s, k) => [s, k < 4 ? over : linear]));
    const b = buildBrief(i, tape(allRows()), steady, costs, NOW, 0, NOW);
    expect(b.picks?.map((p) => p.symbol)).toEqual(short.slice(4, 8));
    expect(b.dropped.filter((d) => /couldn’t be read/.test(d.why))).toEqual([]);
    const seen = b.dropped.map((d) => d.symbol);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen, ...b.picks!.map((p) => p.symbol)].sort()).toEqual(STOCKS.map((s) => s.symbol).sort());
  });

  it('a small budget still takes fewer stocks, and unused candidates say it was the budget', () => {
    const b = run(input({ theme: 'Any', minStocks: 2, budgetUsd: 20 }), steadyOf({}, 2_000_000));
    expect(b.picks).toHaveLength(2);
    const unused = b.dropped.filter((d) => /covers at most 2 stocks/.test(d.why));
    expect(unused).toHaveLength(STOCKS.length - 2);
    expect(b.steps.at(-1)?.label).toBe('the 2 with the deepest pools that your budget covers at $10 or more each');
  });

  it('when the cost limit empties the basket, untried stocks aren’t said to be “within” it or beaten by deeper pools', () => {
    // Caught on live data with a 0.01% limit: 13 passed, the 8 deepest were all over it.
    const b = run(input({ theme: 'Any', minStocks: 4 }), steadyOf({}, 2_000_000), allRows(), costsFor(over));
    expect(b.picks).toBeNull();
    expect(b.steps.slice(-2).map((s) => [s.symbols.length, s.label])).toEqual([
      [BRIEF_LIMITS.maxCandidates, `the ${BRIEF_LIMITS.maxCandidates} with the deepest pools, tried in turn against your cost limit`],
      [0, 'within your cost limit'],
    ]);
    expect(b.dropped.some((d) => /deeper pools made it/.test(d.why))).toBe(false);
    expect(b.dropped.filter((d) => /are tried against your cost limit; this one comes after them/.test(d.why))).toHaveLength(STOCKS.length - BRIEF_LIMITS.maxCandidates);
    expect(b.shortfall).toMatch(/^Your 0.3% limit on what you’ll pay to trade leaves out every stock it was tried on/);
  });

  it('an unreadable pool is its own step, not a cost-limit drop (real-money review of the refill)', () => {
    const costs = costsFor(over);
    costs.set('MUc', null);
    const b = run(input({ minStocks: 2 }), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000, AMDc: 1_000_000 }, 0), allRows(), costs);
    expect(b.steps.slice(-2).map((s) => [s.symbols.length, s.label])).toEqual([
      [2, 'with a pool that could be read just now'],
      [0, 'within your cost limit'],
    ]);
    expect(b.shortfall).toBe('Your 0.3% limit on what you’ll pay to trade leaves out NVDA, AMD, and the pools of MU couldn’t be read just now, so there is no basket.');
  });

  it('a swap fee over the limit is named as the cause, not the pools', () => {
    const b = buildBrief(input({ minStocks: 2, maxCostBp: 20 }), tape(allRows()), steadyOf({ NVDAc: 2_000_000, MUc: 1_500_000 }, 0), costsFor(), NOW, 25, NOW);
    expect(b.shortfall).toBe('Afterbook’s 0.25% swap fee alone is over your 0.2% limit on what you’ll pay to trade, so there is no basket.');
  });

  it('a budget too small for any stock gives every stock the budget reason', () => {
    const b = run(input({ theme: 'Any', minStocks: 2, budgetUsd: 10, cashPct: 50 }), steadyOf({}, 2_000_000));
    expect(b.picks).toBeNull();
    expect(b.shortfall).toMatch(/too little/);
    expect(b.dropped.some((d) => /tried against your cost limit/.test(d.why))).toBe(false);
    expect(b.steps.some((s) => /^the 0 /.test(s.label))).toBe(false);
  });

  it('a budget that covers no stock shows no sizing steps at all (review of PR #176)', () => {
    const b = run(input({ minStocks: 2, budgetUsd: 10, cashPct: 50 }), steadyOf(aiChips, 0));
    expect(b.picks).toBeNull();
    expect(b.steps.map((s) => s.symbols.length)).toEqual([7, 5, 5]);
    expect(b.steps.at(-1)?.label).toBe('that pass your price and earnings limits');
    expect(b.shortfall).toMatch(/^Your \$5\.00 to invest is too little/);
  });

  it('the budget message also names a pool that couldn’t be read', () => {
    const costs = costsFor();
    costs.set('NVDAc', null);
    const b = run(input({ minStocks: 3, budgetUsd: 25 }), steadyOf(aiChips, 0), allRows(), costs);
    expect(b.shortfall).toMatch(/Raise the budget or keep less as cash\. The pool of NVDA couldn’t be read just now\.$/);
  });

  it('too small a budget and the cost limit both: the message names both (review of PR #175)', () => {
    const costs = costsFor(over);
    costs.set('MRVLc', linear);
    const b = run(input({ minStocks: 3, budgetUsd: 25 }), steadyOf(aiChips, 0), allRows(), costs);
    expect(b.picks).toBeNull();
    expect(b.shortfall).toBe(
      'Your $25.00 to invest is too little for at least $10 in each of 3 stocks. Raise the budget or keep less as cash. Your 0.3% cost limit also left out NVDA, MU, AMD, AVGO.',
    );
  });
});
