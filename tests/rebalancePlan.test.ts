import { describe, expect, it } from 'vitest';
import { planRebalance, type RebalanceInput } from '../lib/agent/rebalancePlan';
import type { CostModel } from '../lib/agent/plan';
import type { Target } from '../lib/agent/rebalance';
import type { TapeResult, TapeRow } from '../lib/market/tape';
import { STOCKS } from '../lib/stocks/tokens';
import { splitBasketUsdc } from '../lib/swap/basketBuy';

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
  onchainMidUsd: 100,
  tick: 0,
  basisBp: 20,
  depthUsd: 2_000_000,
  depthShares: 20_000,
  multiplier: 1,
  nextEarningsDate: null,
  ...over,
});
const tape = (over: Record<string, Partial<TapeRow>> = {}): Pick<TapeResult, 'rows' | 'session'> => ({
  rows: STOCKS.map((s) => row(s.symbol, over[s.symbol])),
  session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-13', nextOpenIso: '2026-11-16T14:30:00.000Z' },
});
const linear: CostModel = { estimate: (u) => ({ sharesOut: u / 100, impactBp: 5 + u / 1000 }), sizeForImpact: (bp) => Math.max(0, (bp - 5) * 1000) };
const over: CostModel = { estimate: (u) => ({ sharesOut: u / 100, impactBp: 500 }), sizeForImpact: () => 1 };
const costsFor = (m: CostModel | null = linear) => new Map<string, CostModel | null>(STOCKS.map((s) => [s.symbol, m]));
const tokens = (s: string) => STOCKS.find((x) => x.symbol === s);
const dec = (s: string) => tokens(s)!.decimals;
/** `n` tokens of a stock as a raw balance. */
const raw = (s: string, n: number) => BigInt(Math.round(n * 1e6)) * BigInt(10) ** BigInt(dec(s) - 6);

const T: Target[] = [
  { symbol: 'NVDAc', weightPct: 40 },
  { symbol: 'MSFTc', weightPct: 30 },
  { symbol: 'AAPLc', weightPct: 30 },
];
const input = (o: Partial<RebalanceInput> = {}): RebalanceInput => ({ targets: T, budgetUsd: 300, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 0, balances: {}, ...o });
const run = (i: RebalanceInput, t = tape(), costs = costsFor()) => planRebalance(i, t, tokens, costs, NOW, 0, NOW);

describe('planRebalance', () => {
  it('values holdings as tokens × multiplier × onchain price', () => {
    const p = run(input({ balances: { NVDAc: raw('NVDAc', 2), MSFTc: raw('MSFTc', 1) } }), tape({ NVDAc: { multiplier: 1.5 } }));
    expect(p.drift.map((d) => d.valueUsd)).toEqual([300, 100, 0]);
  });

  it('nothing held: buys at the target weights, exactly what the basket buy will split', () => {
    const p = run(input());
    expect(p.picks?.map((x) => [x.symbol, x.usd])).toEqual([
      ['NVDAc', 120],
      ['MSFTc', 90],
      ['AAPLc', 90],
    ]);
    expect(p.basket?.map((b) => b.weightPct)).toEqual([40, 30, 30]);
    const split = splitBasketUsdc(BigInt(p.investedUsd * 1e6), p.basket!);
    expect(split.map((l) => Number(l.amountIn) / 1e6)).toEqual([120, 90, 90]);
    expect(p.cashUsd).toBe(0);
  });

  it('puts the run into the stock under target', () => {
    // 6 NVDA ($600) and 3 MSFT ($300), no AAPL; +$300 → $1,200, AAPL target $360.
    const p = run(input({ balances: { NVDAc: raw('NVDAc', 6), MSFTc: raw('MSFTc', 3) } }));
    expect(p.picks?.map((x) => x.symbol)).toEqual(['MSFTc', 'AAPLc']);
    expect(p.picks?.find((x) => x.symbol === 'AAPLc')!.usd).toBeGreaterThan(p.picks?.find((x) => x.symbol === 'MSFTc')!.usd ?? 0);
    expect(p.investedUsd).toBeLessThanOrEqual(300);
    // NVDA passed its checks but is over target: said so, not its passing gap sentence (live page, 2026-11-14).
    expect(p.notBought).toEqual([{ symbol: 'NVDAc', why: 'It’s at or over its target, so this run puts nothing into it.' }]);
  });

  it('a stock over the price limit sits this run out; the others get their target share and the rest stays as cash', () => {
    const p = run(input(), tape({ NVDAc: { basisBp: 120 } }));
    expect(p.picks?.map((x) => [x.symbol, x.usd])).toEqual([
      ['MSFTc', 90],
      ['AAPLc', 90],
    ]);
    expect(p.investedUsd).toBe(180);
    expect(p.cashUsd).toBe(120);
    expect(p.cashWhy).toMatch(/^because NVDA is under target but can’t be bought this run/);
    expect(p.legs.find((l) => l.symbol === 'NVDAc')?.verdict).not.toBe('buy');
  });

  it('a stock over the cost limit is left out with its reason, the rest split again', () => {
    const costs = costsFor();
    costs.set('AAPLc', over);
    const p = run(input(), tape(), costs);
    expect(p.picks?.map((x) => x.symbol)).toEqual(['NVDAc', 'MSFTc']);
    expect(p.legs.find((l) => l.symbol === 'AAPLc')?.decidedBy).toMatch(/cost more than your/);
    expect(p.investedUsd).toBeLessThanOrEqual(300);
  });

  it('review repro: 34/33/33 holding $372/$5,406/$5,687 with $5,000 spends nearly all of it', () => {
    const T3: Target[] = [
      { symbol: 'NVDAc', weightPct: 34 },
      { symbol: 'MSFTc', weightPct: 33 },
      { symbol: 'AAPLc', weightPct: 33 },
    ];
    const big: CostModel = { estimate: (u) => ({ sharesOut: u / 100, impactBp: 5 }), sizeForImpact: () => 1e9 };
    const tp = tape(Object.fromEntries(['NVDAc', 'MSFTc', 'AAPLc'].map((s) => [s, { depthUsd: 1e8 }])));
    const p = run(input({ targets: T3, budgetUsd: 5000, balances: { NVDAc: raw('NVDAc', 3.72), MSFTc: raw('MSFTc', 54.06), AAPLc: raw('AAPLc', 56.87) } }), tp, costsFor(big));
    expect(p.investedUsd).toBeGreaterThanOrEqual(4950);
    expect(p.picks?.map((x) => x.symbol)).toEqual(['NVDAc']);
    expect(p.notBought.find((n) => n.symbol === 'MSFTc')?.why).toMatch(/^It’s at or over its target now, and its small share of this run would have left much of the run unspent/);
  });

  it('review repro: 50/50 holding $900/$100, MSFT fails its gap check: nothing goes into NVDA', () => {
    const T2: Target[] = [
      { symbol: 'NVDAc', weightPct: 50 },
      { symbol: 'MSFTc', weightPct: 50 },
    ];
    const p = run(input({ targets: T2, budgetUsd: 500, balances: { NVDAc: raw('NVDAc', 9), MSFTc: raw('MSFTc', 1) } }), tape({ MSFTc: { basisBp: 120 } }));
    expect(p.picks).toBeNull();
    expect(p.cashUsd).toBe(500);
    expect(p.shortfall).toMatch(/stays in your wallet/);
    expect(p.shortfall).toMatch(/NVDA: It’s at or over its target share after this run/);
  });

  it('fuzz: rounding leaves at most a few percent of the run unspent', () => {
    let seed = 5;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const big: CostModel = { estimate: (u) => ({ sharesOut: u / 100, impactBp: 5 }), sizeForImpact: () => 1e9 };
    const tp = tape(Object.fromEntries(T.map((t) => [t.symbol, { depthUsd: 1e8 }])));
    const lost: number[] = [];
    for (let k = 0; k < 1000; k++) {
      const budgetUsd = 50 + Math.floor(rnd() * 5000);
      const balances = Object.fromEntries(T.map((t) => [t.symbol, raw(t.symbol, rnd() * 60)]));
      const p = run(input({ budgetUsd, balances }), tp, costsFor(big));
      if (!p.picks) continue;
      lost.push(p.roundingUsd / budgetUsd);
    }
    lost.sort((a, b) => a - b);
    expect(lost[Math.floor(lost.length * 0.9)]).toBeLessThan(0.02);
    expect(lost[lost.length - 1]).toBeLessThan(0.1);
  });

  it('nothing passes: no buy, every reason given', () => {
    const p = run(input(), tape(), costsFor(over));
    expect(p.picks).toBeNull();
    expect(p.shortfall).toMatch(/^Nothing can be bought for this run right now, so the run stays in your wallet\. NVDA: Even a \$10 buy/);
    expect(p.cashUsd).toBe(300);
  });

  it('a held stock with no price: no buy (the drift can’t be trusted)', () => {
    const p = run(input({ balances: { NVDAc: raw('NVDAc', 1) } }), tape({ NVDAc: { onchainMidUsd: null } }));
    expect(p.picks).toBeNull();
    expect(p.unpriced).toEqual(['NVDAc']);
    expect(p.shortfall).toMatch(/price of NVDA couldn’t be read/);
  });

  it('fuzz: within the run, every pick at least $10, at most what it was sized for', () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 400; k++) {
      const budgetUsd = 10 + Math.floor(rnd() * 5000);
      const balances = Object.fromEntries(T.map((t) => [t.symbol, raw(t.symbol, rnd() < 0.3 ? 0 : rnd() * 40)]));
      const costs = costsFor();
      if (rnd() < 0.2) costs.set('MSFTc', over);
      const p = run(input({ budgetUsd, balances }), tape(), costs);
      if (!p.picks) continue;
      expect(p.investedUsd).toBeLessThanOrEqual(budgetUsd);
      const split = splitBasketUsdc(BigInt(Math.round(p.investedUsd * 1e6)), p.basket!);
      for (const leg of split) {
        const pick = p.picks.find((x) => x.symbol === leg.symbol)!;
        expect(Number(leg.amountIn) / 1e6).toBeCloseTo(pick.usd, 2);
        expect(pick.usd).toBeGreaterThanOrEqual(10);
        expect(pick.usd).toBeLessThanOrEqual(p.legs.find((l) => l.symbol === leg.symbol)!.usd! + 0.01);
      }
    }
  });
});
