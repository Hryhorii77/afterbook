// One run of a rebalance rule (/rules, lib/agent/rebalance.ts), checked with the trade plan's own code:
// the holdings the page read onchain are priced from the tape, the run is split over the stocks below
// target (topUpSplit), each stock goes through screen (gap, stale pool, earnings, pool depth) and
// sizeLegs (the cost limit, $25k and 10% of the pool), and the result is the basket buy's whole-percent
// weights and total, so no stock gets more than it was sized for. A stock that can't be bought this run
// is left out with its reason and the run is split again over the rest. Pure: the route passes the tape,
// the cost models and the clock.

import type { TapeResult } from '../market/tape';
import type { BasketLeg } from '../build/customBasket';
import { usd } from '../format';
import { screen, sizeLegs, type CostModel, type PlanInput, type PlanLeg } from './plan';
import { PLAN_LIMITS } from './limits';
import { driftRows, topUpLegs, wholePercentBasket, type DriftRow, type Target } from './rebalance';

export interface RebalanceInput {
  targets: Target[];
  /** What this run may spend (the rule's amount, cut to what's left of its cap). */
  budgetUsd: number;
  maxPremiumBp: number;
  maxCostBp: number;
  earningsDays: number;
  /** Raw token balances the page read onchain, by symbol (missing = 0). */
  balances: Record<string, bigint>;
}

export interface RebalancePick {
  symbol: string;
  name: string;
  weightPct: number;
  /** What the basket buy will put into it, to the cent. */
  usd: number;
  costBp: number;
  sizedDownBy: 'cost limit' | 'swap caps' | null;
}

export interface RebalancePlan {
  drift: DriftRow[];
  /** Every target with the checks' verdict and reasons (a sized amount for those bought this run). */
  legs: PlanLeg[];
  picks: RebalancePick[] | null;
  /** Whole-percent weights for the basket buy, in the picks' order. */
  basket: BasketLeg[] | null;
  investedUsd: number;
  /** What this run leaves in the wallet: rounding, or a stock sized down by the cost limit or the caps. */
  cashUsd: number;
  /** Why there is nothing to buy this run, or null. */
  shortfall: string | null;
  /** A target whose price or balance couldn't be valued: the drift view can't be trusted, so no buy. */
  unpriced: string[];
  /** Each target that gets nothing this run, and why (a failed check, or already at or over target). */
  notBought: { symbol: string; why: string }[];
}

export interface TokenInfo {
  decimals: number;
}

export function planRebalance(
  input: RebalanceInput,
  tape: Pick<TapeResult, 'rows' | 'session'>,
  tokens: (symbol: string) => TokenInfo | undefined,
  costs: Map<string, CostModel | null>,
  earningsSyncedAt: number | null,
  feeBps = 0,
  now = Date.now(),
): RebalancePlan {
  const syms = input.targets.map((t) => t.symbol);
  // Value what the wallet holds: tokens × the B20 multiplier × the onchain price (as My Lots does).
  const valuesUsd: Record<string, number> = {};
  const unpriced: string[] = [];
  for (const sym of syms) {
    const row = tape.rows.find((r) => r.symbol === sym);
    const tok = tokens(sym);
    const raw = input.balances[sym] ?? BigInt(0);
    if (raw === BigInt(0)) {
      valuesUsd[sym] = 0;
      continue;
    }
    if (!row || !tok || row.onchainMidUsd == null || !(row.onchainMidUsd > 0)) {
      unpriced.push(sym);
      valuesUsd[sym] = 0;
      continue;
    }
    valuesUsd[sym] = (Number(raw) / 10 ** tok.decimals) * (row.multiplier ?? 1) * row.onchainMidUsd;
  }
  const drift = driftRows(input.targets, valuesUsd);
  const none = (legs: PlanLeg[], shortfall: string, notBought: RebalancePlan['notBought'] = []): RebalancePlan => ({
    drift, legs, picks: null, basket: null, investedUsd: 0, cashUsd: input.budgetUsd, shortfall, unpriced, notBought,
  });
  if (unpriced.length) {
    return none([], `The price of ${unpriced.map((s) => s.replace(/c$/, '')).join(', ')} couldn’t be read just now, so where your basket stands can’t be worked out. Check the run again in a moment.`);
  }

  const planInput: PlanInput = { symbols: syms, budgetUsd: input.budgetUsd, maxPremiumBp: input.maxPremiumBp, maxCostBp: input.maxCostBp, earningsDays: input.earningsDays, note: '' };
  const legs = screen(planInput, tape, earningsSyncedAt, now).filter((l) => syms.includes(l.symbol));
  const out = new Map<string, string>(); // symbol → why it isn't bought this run
  for (const l of legs) if (l.verdict !== 'buy') out.set(l.symbol, l.decidedBy ?? l.reasons[0] ?? 'It didn’t pass your limits.');
  for (const sym of syms) if (!legs.some((l) => l.symbol === sym)) out.set(sym, 'It isn’t on the tape right now.');

  const skip = (l: PlanLeg, why: string) => {
    l.verdict = 'skip';
    l.decidedBy = why;
    l.reasons.push(why);
    out.set(l.symbol, why);
  };

  // Split, size each stock at its share, and split again without any that fail, until stable.
  for (;;) {
    const among = syms.filter((s) => !out.has(s));
    if (!among.length) break;
    const { legs: split, tooSmall } = topUpLegs(input.targets, valuesUsd, input.budgetUsd, among);
    for (const sym of tooSmall) {
      const l = legs.find((x) => x.symbol === sym);
      if (l) skip(l, `Its share of this run would be under the ${usd(PLAN_LIMITS.minLegUsd, 0)} minimum for a swap.`);
    }
    if (!split.length) break;
    const trials = split.map((s) => {
      const base = legs.find((l) => l.symbol === s.symbol)!;
      const t: PlanLeg = { ...base, reasons: [...base.reasons] };
      sizeLegs([t], { ...planInput, symbols: [s.symbol], budgetUsd: s.usd }, costs, feeBps);
      return t;
    });
    const failed = trials.filter((t) => t.verdict !== 'buy' || !((t.usd ?? 0) > 0));
    if (failed.length) {
      for (const t of failed) skip(legs.find((l) => l.symbol === t.symbol)!, t.decidedBy ?? 'It didn’t pass your limits.');
      continue;
    }
    const whole = wholePercentBasket(trials.map((t) => ({ symbol: t.symbol, usd: t.usd! })));
    if (whole.dropped.length) {
      for (const sym of whole.dropped) skip(legs.find((l) => l.symbol === sym)!, `Its share of this run would be under the ${usd(PLAN_LIMITS.minLegUsd, 0)} minimum for a swap after the split.`);
      continue;
    }
    // Write the sized outcome back, so the legs say what was bought.
    for (const t of trials) Object.assign(legs.find((l) => l.symbol === t.symbol)!, { verdict: t.verdict, reasons: t.reasons, usd: t.usd, shares: t.shares, costBp: t.costBp, cutBy: t.cutBy });
    const picks: RebalancePick[] = trials.map((t) => {
      const legUsd = whole.legUsd[t.symbol];
      const model = costs.get(t.symbol);
      return {
        symbol: t.symbol,
        name: t.name,
        weightPct: whole.basket.find((b) => b.symbol === t.symbol)!.weightPct,
        usd: legUsd,
        // At most the sized amount, so at most its cost; re-estimated at the amount actually bought.
        costBp: model ? model.estimate(legUsd).impactBp + feeBps : (t.costBp ?? 0),
        sizedDownBy: t.cutBy ?? null,
      };
    });
    // A stock that passed but got no share is at or over its target (the run went to the ones under).
    const notBought = syms
      .filter((sym) => !picks.some((p) => p.symbol === sym))
      .map((sym) => ({ symbol: sym, why: out.get(sym) ?? 'It’s at or over its target, so this run puts nothing into it.' }));
    return {
      drift,
      legs,
      picks,
      notBought,
      basket: whole.basket,
      investedUsd: whole.investedUsd,
      cashUsd: Math.round((input.budgetUsd - whole.investedUsd) * 100) / 100,
      shortfall: null,
      unpriced,
    };
  }
  const reasons = syms.filter((s) => out.has(s)).map((s) => `${s.replace(/c$/, '')}: ${out.get(s)}`);
  return none(
    legs,
    `Nothing can be bought for this run right now. ${reasons.join(' ')}`.trim(),
    syms.filter((s) => out.has(s)).map((s) => ({ symbol: s, why: out.get(s)! })),
  );
}
