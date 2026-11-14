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
import { driftRows, shortfallUsd, topUpLegs, wholePercentBasket, type DriftRow, type Target } from './rebalance';

const ticker = (s: string) => s.replace(/c$/, '');

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
  /** What this run leaves in the wallet: rounding, a stock sized down by the cost limit or the caps, or
   *  money held back because the stocks under target can't be bought this run. */
  cashUsd: number;
  /** Why `cashUsd` stays in the wallet ("because …", or "for these reasons: $x because …; …"), or null. */
  cashWhy: string | null;
  /** How much of the run the whole-percent split alone leaves unspent. */
  roundingUsd: number;
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
    drift, legs, picks: null, basket: null, investedUsd: 0, cashUsd: input.budgetUsd, cashWhy: null, roundingUsd: 0, shortfall, unpriced, notBought,
  });
  if (unpriced.length) {
    return none([], `The price of ${unpriced.map(ticker).join(', ')} couldn’t be read just now, so where your basket stands can’t be worked out. Check the run again in a moment.`);
  }

  const planInput: PlanInput = { symbols: syms, budgetUsd: input.budgetUsd, maxPremiumBp: input.maxPremiumBp, maxCostBp: input.maxCostBp, earningsDays: input.earningsDays, note: '' };
  const screened = screen(planInput, tape, earningsSyncedAt, now).filter((l) => syms.includes(l.symbol));
  const firstOut = new Map<string, string>(); // symbol → why it isn't bought this run
  for (const l of screened) if (l.verdict !== 'buy') firstOut.set(l.symbol, l.decidedBy ?? l.reasons[0] ?? 'It didn’t pass your limits.');
  for (const sym of syms) if (!screened.some((l) => l.symbol === sym)) firstOut.set(sym, 'It isn’t on the tape right now.');

  const totalAfter = drift.reduce((s, d) => s + d.valueUsd, 0) + input.budgetUsd;
  const overNow = (sym: string) => (drift.find((d) => d.symbol === sym)?.driftPts ?? -1) >= 0;
  // A stock whose share of the run is too small to buy: say so, and say why its share is small.
  const smallWhy = (sym: string, afterSplit: boolean) =>
    overNow(sym)
      ? 'It’s at or over its target now, so its share of this run is small, under the ' + usd(PLAN_LIMITS.minLegUsd, 0) + ' minimum for a swap' + (afterSplit ? ' once split into whole percents.' : '.')
      : 'Its share of this run would be under the ' + usd(PLAN_LIMITS.minLegUsd, 0) + ' minimum for a swap' + (afterSplit ? ' once split into whole percents.' : '.');
  const roundingWhy = (sym: string) =>
    overNow(sym)
      ? 'It’s at or over its target now, and its small share of this run would have left much of the run unspent in the basket buy’s whole-percent split, so the run goes to the others.'
      : 'Its share of this run is so small that the basket buy’s whole-percent split would have left much of the run unspent, so the run goes to the others.';

  /** Split, size each stock at its share, and split again without any that fail, until stable. */
  const attempt = (outStart: Map<string, string>): RebalancePlan => {
    const out = new Map(outStart);
    const legs: PlanLeg[] = screened.map((l) => ({ ...l, reasons: [...l.reasons] }));
    const skip = (l: PlanLeg, why: string) => {
      l.verdict = 'skip';
      l.decidedBy = why;
      l.reasons.push(why);
      out.set(l.symbol, why);
    };
    for (const [sym, why] of outStart) {
      const l = legs.find((x) => x.symbol === sym);
      if (l && l.verdict === 'buy') skip(l, why);
    }
    for (;;) {
      const among = syms.filter((s) => !out.has(s));
      if (!among.length) break;
      const { legs: split, tooSmall } = topUpLegs(input.targets, valuesUsd, input.budgetUsd, among);
      for (const sym of tooSmall) {
        const l = legs.find((x) => x.symbol === sym);
        if (l) skip(l, smallWhy(sym, false));
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
        for (const sym of whole.dropped) skip(legs.find((l) => l.symbol === sym)!, smallWhy(sym, true));
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
      // A stock that passed but got no share is at or over its target share after this run.
      const notBought = syms
        .filter((sym) => !picks.some((p) => p.symbol === sym))
        .map((sym) => ({ symbol: sym, why: out.get(sym) ?? 'It’s at or over its target, so this run puts nothing into it.' }));
      const cents = (v: number) => Math.round(v * 100) / 100;
      const splitUsd = split.reduce((s, x) => s + x.usd, 0);
      const sizedUsd = trials.reduce((s, t) => s + t.usd!, 0);
      const cashUsd = cents(input.budgetUsd - whole.investedUsd);
      // Why money stays in the wallet, biggest part first.
      const parts: { usd: number; text: string }[] = [];
      const held = cents(input.budgetUsd - splitUsd);
      if (held >= 1) {
        const under = input.targets
          .filter((t) => !picks.some((p) => p.symbol === t.symbol) && shortfallUsd(t, valuesUsd, totalAfter) > 0)
          .map((t) => ticker(t.symbol));
        parts.push({
          usd: held,
          text: under.length
            ? `${under.join(' and ')} ${under.length === 1 ? 'is' : 'are'} under target but can’t be bought this run, and the others get no more than their target share after this run (apart from a few dollars from a stock too small to buy)`
            : 'the others get no more than their target share after this run (apart from a few dollars from a stock too small to buy)',
        });
      }
      const cut = cents(splitUsd - sizedUsd);
      if (cut >= 1) parts.push({ usd: cut, text: 'a stock was cut to fit your cost limit or the swap caps' });
      const rounded = cents(sizedUsd - whole.investedUsd);
      if (rounded >= 0.01) parts.push({ usd: rounded, text: 'the basket buy splits in whole percents, so the total is lowered until no stock gets more than it was sized for' });
      parts.sort((x, y) => y.usd - x.usd);
      return {
        drift,
        legs,
        picks,
        notBought,
        basket: whole.basket,
        investedUsd: whole.investedUsd,
        cashUsd,
        cashWhy:
          cashUsd < 0.01
            ? null
            : parts.length > 1
              ? `for these reasons: ${parts.map((x) => `${usd(x.usd, 2)} because ${x.text}`).join('; ')}`
              : `because ${parts[0]?.text ?? 'amounts are rounded down, so no stock gets more than it was sized for'}`,
        roundingUsd: rounded,
        shortfall: null,
        unpriced,
      };
    }
    // Nothing to buy: the ones under target failed, and the rest are at or over their share after this run.
    const why = (s: string) => out.get(s) ?? 'It’s at or over its target share after this run, so this run puts nothing into it.';
    return none(
      legs,
      `Nothing can be bought for this run right now, so the run stays in your wallet. ${syms.map((s) => `${ticker(s)}: ${why(s)}`).join(' ')}`.trim(),
      syms.map((s) => ({ symbol: s, why: why(s) })),
    );
  };

  // Whole-percent rounding can leave much of a lopsided run unspent (a stock with 0.5% of it forces the
  // total down to 100× its amount). Also try without the smallest pick, and keep the one that spends more
  // by at least 1% of the run (review, 2026-11-14).
  let out = firstOut;
  let best = attempt(out);
  while (best.picks && best.picks.length > 1 && best.roundingUsd >= Math.max(1, input.budgetUsd * 0.01)) {
    const smallest = best.picks.reduce((a, b) => (b.usd < a.usd ? b : a));
    const tryOut = new Map(out).set(smallest.symbol, roundingWhy(smallest.symbol));
    const alt = attempt(tryOut);
    if (!(alt.investedUsd >= best.investedUsd + Math.max(1, input.budgetUsd * 0.01))) break;
    best = alt;
    out = tryOut;
  }
  return best;
}
