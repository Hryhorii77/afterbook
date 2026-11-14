import { describe, expect, it } from 'vitest';
import { driftRows, isTargets, topUpLegs, topUpSplit, wholePercentBasket, type Target } from '../lib/agent/rebalance';
import { cleanRules, cleanRuns, isRule, REBALANCE_SYMBOL, ruleLabel, runSymbol, type Rule } from '../lib/agent/rules';
import { STOCKS } from '../lib/stocks/tokens';
import { splitBasketUsdc } from '../lib/swap/basketBuy';

const known = (s: string) => STOCKS.some((x) => x.symbol === s);
const T: Target[] = [
  { symbol: 'NVDAc', weightPct: 40 },
  { symbol: 'MSFTc', weightPct: 30 },
  { symbol: 'AAPLc', weightPct: 30 },
];
const sum = (xs: { usd: number }[]) => Math.round(xs.reduce((s, x) => s + x.usd, 0) * 100) / 100;

describe('isTargets', () => {
  it('2-4 distinct known stocks, whole percents 1-99 adding to 100', () => {
    expect(isTargets(T, known)).toBe(true);
    expect(isTargets([{ symbol: 'NVDAc', weightPct: 100 }], known)).toBe(false);
    expect(isTargets([...T, { symbol: 'METAc', weightPct: 0 }], known)).toBe(false);
    expect(isTargets([{ symbol: 'NVDAc', weightPct: 50 }, { symbol: 'NVDAc', weightPct: 50 }], known)).toBe(false);
    expect(isTargets([{ symbol: 'NVDAc', weightPct: 50.5 }, { symbol: 'MSFTc', weightPct: 49.5 }], known)).toBe(false);
    expect(isTargets([{ symbol: 'NVDAc', weightPct: 50 }, { symbol: 'MSFTc', weightPct: 49 }], known)).toBe(false);
    expect(isTargets([{ symbol: 'XYZc', weightPct: 50 }, { symbol: 'MSFTc', weightPct: 50 }], known)).toBe(false);
    const five = ['NVDAc', 'MSFTc', 'AAPLc', 'METAc', 'AMZNc'].map((symbol) => ({ symbol, weightPct: 20 }));
    expect(isTargets(five, known)).toBe(false);
  });
});

describe('topUpSplit (owner, 2026-11-14)', () => {
  it('nothing held: the run goes at the target weights', () => {
    expect(topUpSplit(T, {}, 100)).toEqual([
      { symbol: 'NVDAc', usd: 40 },
      { symbol: 'MSFTc', usd: 30 },
      { symbol: 'AAPLc', usd: 30 },
    ]);
  });
  it('to the stocks under target, in proportion to how far under, never pushing one over target', () => {
    // Holds 600 NVDA, 300 MSFT, 0 AAPL; +100 → total 1000, targets 400/300/300: AAPL is 300 under, NVDA 200 over.
    const s = topUpSplit(T, { NVDAc: 600, MSFTc: 300, AAPLc: 0 }, 100);
    expect(s).toEqual([
      { symbol: 'NVDAc', usd: 0 },
      { symbol: 'MSFTc', usd: 0 },
      { symbol: 'AAPLc', usd: 100 },
    ]);
    // Two under: 100 split 2:1 by their shortfalls (200 and 100).
    const t = topUpSplit(T, { NVDAc: 200, MSFTc: 200, AAPLc: 500 }, 100);
    expect(t.map((x) => x.usd)).toEqual([66.66, 33.33, 0]);
  });
  it('every stock already at target: the run goes at the target weights', () => {
    expect(topUpSplit(T, { NVDAc: 400, MSFTc: 300, AAPLc: 300 }, 100).map((x) => x.usd)).toEqual([40, 30, 30]);
  });
  it('only some can be bought: fill their shortfall, the rest by target weight', () => {
    // AAPL can't be bought now. NVDA 100 under, MSFT 0 under; 200 to spend: 100 to NVDA, then 100 split 40:30.
    const s = topUpSplit(T, { NVDAc: 380, MSFTc: 390, AAPLc: 330 }, 200, ['NVDAc', 'MSFTc']);
    expect(s.map((x) => x.symbol)).toEqual(['NVDAc', 'MSFTc']);
    expect(sum(s)).toBeLessThanOrEqual(200);
    expect(s[0].usd).toBeGreaterThan(s[1].usd);
  });
  it('fuzz: never spends more than the run, never negative', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 2000; k++) {
      const vals = { NVDAc: rnd() * 5000, MSFTc: rnd() * 5000, AAPLc: rnd() < 0.3 ? 0 : rnd() * 5000 };
      const budget = 10 + Math.floor(rnd() * 3000);
      const among = T.map((t) => t.symbol).filter(() => rnd() > 0.2);
      const s = topUpSplit(T, vals, budget, among.length ? among : ['NVDAc']);
      expect(sum(s)).toBeLessThanOrEqual(budget);
      expect(s.every((x) => x.usd >= 0)).toBe(true);
      expect(sum(s)).toBeGreaterThan(budget - 0.05);
    }
  });
});

describe('topUpLegs', () => {
  it('a share under $10 is left out and the run is split again', () => {
    // $50 at targets 40/30/30, but NVDA is far over target: MSFT and AAPL are under.
    const { legs, tooSmall } = topUpLegs(T, { NVDAc: 1000, MSFTc: 290, AAPLc: 300 }, 50, ['NVDAc', 'MSFTc', 'AAPLc']);
    expect(legs.every((l) => l.usd >= 10)).toBe(true);
    expect(sum(legs)).toBeLessThanOrEqual(50);
    expect(tooSmall.length + legs.length).toBeLessThanOrEqual(3);
  });
  it('a run too small for any stock returns no legs', () => {
    expect(topUpLegs(T, {}, 5, ['NVDAc', 'MSFTc', 'AAPLc']).legs).toEqual([]);
  });
});

describe('wholePercentBasket', () => {
  it('no stock gets more than it was sized for, to the cent', () => {
    const sized = [
      { symbol: 'NVDAc', usd: 66 },
      { symbol: 'MSFTc', usd: 33 },
    ];
    const w = wholePercentBasket(sized);
    expect(w.dropped).toEqual([]);
    const split = splitBasketUsdc(BigInt(Math.round(w.investedUsd * 1e6)), w.basket);
    for (const leg of split) {
      const sizedUsd = sized.find((s) => s.symbol === leg.symbol)!.usd;
      expect(Number(leg.amountIn) / 1e6).toBeLessThanOrEqual(sizedUsd + 0.01);
    }
  });
});

describe('driftRows', () => {
  it('current share and drift in points', () => {
    const d = driftRows(T, { NVDAc: 500, MSFTc: 250, AAPLc: 250 });
    expect(d.map((x) => [x.currentPct, x.driftPts])).toEqual([
      [50, 10],
      [25, -5],
      [25, -5],
    ]);
    expect(driftRows(T, {})[0]).toMatchObject({ currentPct: null, driftPts: null });
  });
});

describe('rebalance rules in storage', () => {
  const base = { id: 'rabc123', usd: 100, cadence: { kind: 'weekly', weekday: 1 }, capUsd: null, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2, paused: false, startKey: '2026-11-14', createdAt: 1 };
  const rb = { ...base, symbol: REBALANCE_SYMBOL, kind: 'rebalance', targets: T };
  it('accepts a rebalance rule; refuses a half-made one', () => {
    expect(isRule(rb, known)).toBe(true);
    expect(isRule({ ...rb, targets: T.slice(0, 1) }, known)).toBe(false);
    expect(isRule({ ...rb, symbol: 'NVDAc' }, known)).toBe(false); // would read as a one-stock rule elsewhere
    expect(isRule({ ...base, symbol: 'NVDAc', targets: T }, known)).toBe(false); // targets without the kind
    expect(isRule({ ...base, symbol: REBALANCE_SYMBOL }, known)).toBe(false); // the marker without targets
    expect(isRule({ ...base, symbol: 'NVDAc' }, known)).toBe(true); // one-stock rules unchanged
  });
  it('keeps the targets and drops anything extra', () => {
    const [r] = cleanRules([{ ...rb, targets: T.map((t) => ({ ...t, extra: 1 })), junk: true }], known) as (Rule & { junk?: boolean })[];
    expect(r.targets).toEqual(T);
    expect(r.junk).toBeUndefined();
    expect(ruleLabel(r)).toBe('NVDA 40 · MSFT 30 · AAPL 30');
    expect(runSymbol(r)).toBe('NVDA/MSFT/AAPL');
  });
  it('a rebalance run keeps every hash and its note', () => {
    const h = (n: number) => `0x${String(n).repeat(64)}`;
    const run = { ruleId: 'rabc123', symbol: 'NVDA/MSFT/AAPL', slot: '2026-11-16', at: 2, outcome: 'bought', usd: 70, hash: h(1), hashes: [h(1), h(2)], note: 'Stopped part way: AAPL not bought this run.' };
    expect(cleanRuns([run])).toEqual([run]);
    expect(cleanRuns([{ ...run, hashes: [h(1), 'nope'] }])).toEqual([]);
  });
});
