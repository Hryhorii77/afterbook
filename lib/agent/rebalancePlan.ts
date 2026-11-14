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
import { driftRows, nothingHeld, shortfallUsd, topUpLegs, wholePercentBasket, type DriftRow, type Target } from './rebalance';

const ticker = (s: string) => s.replace(/c$/, '');
/** "NVDA", "NVDA and MSFT", "NVDA, MSFT and AMD". */
const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

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
  /** Nothing held yet and a stock failed its checks: says the others were bought at their weights. */
  firstRunNote: string | null;
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
  const drift = driftRows(input.targets, valuesUsd, input.budgetUsd);
  const fresh = nothingHeld(drift.reduce((s, d) => s + d.valueUsd, 0), input.budgetUsd);
  const none = (legs: PlanLeg[], shortfall: string, notBought: RebalancePlan['notBought'] = []): RebalancePlan => ({
    drift, legs, picks: null, basket: null, investedUsd: 0, cashUsd: input.budgetUsd, cashWhy: null, firstRunNote: null, roundingUsd: 0, shortfall, unpriced, notBought,
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
    const out = new Map(outStart); // failed a check (or left out for rounding): its money isn't spread
    const small = new Map<string, string>(); // left out only for the $10 minimum: its money goes to the others
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
    const tooSmallFor = (l: PlanLeg, why: string) => {
      l.verdict = 'skip';
      l.decidedBy = why;
      l.reasons.push(why);
      small.set(l.symbol, why);
    };
    // A stock dropped for the minimum is small only next to the others: when one of those fails, the split
    // changes, so every dropped one is looked at again (recheck, 2026-11-14: they stayed dropped and their
    // money went into a stock far over target).
    const recheckSmall = () => {
      for (const sym of small.keys()) {
        const base = screened.find((l) => l.symbol === sym)!;
        Object.assign(legs.find((l) => l.symbol === sym)!, { ...base, reasons: [...base.reasons] });
      }
      small.clear();
    };
    for (;;) {
      const among = syms.filter((s) => !out.has(s) && !small.has(s));
      if (!among.length) break;
      const { legs: split, tooSmall } = topUpLegs(input.targets, valuesUsd, input.budgetUsd, among, [...small.keys()]);
      for (const sym of tooSmall) {
        const l = legs.find((x) => x.symbol === sym);
        if (l) tooSmallFor(l, smallWhy(sym, false));
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
        recheckSmall();
        continue;
      }
      const whole = wholePercentBasket(trials.map((t) => ({ symbol: t.symbol, usd: t.usd! })));
      if (whole.dropped.length) {
        for (const sym of whole.dropped) tooSmallFor(legs.find((l) => l.symbol === sym)!, smallWhy(sym, true));
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
        .map((sym) => ({ symbol: sym, why: out.get(sym) ?? small.get(sym) ?? 'It’s at or over its target, so this run puts nothing into it.' }));
      const cents = (v: number) => Math.round(v * 100) / 100;
      const splitUsd = split.reduce((s, x) => s + x.usd, 0);
      const cashUsd = cents(input.budgetUsd - whole.investedUsd);
      // Why money stays in the wallet, biggest part first. The parts add up to the cash exactly.
      const parts: { usd: number; text: string }[] = [];
      const splitLeft = cents(input.budgetUsd - splitUsd);
      const underAfter = (sym: string) => shortfallUsd(input.targets.find((t) => t.symbol === sym)!, valuesUsd, totalAfter) > 0;
      // Failed a check, versus left out by the outer loop only to spend more of the run (whole-percent rounding).
      const failedUnder = syms.filter((sym) => out.has(sym) && out.get(sym) !== roundingWhy(sym) && underAfter(sym)).map(ticker);
      const roundedOut = syms.filter((sym) => out.get(sym) === roundingWhy(sym) && underAfter(sym)).map(ticker);
      // Cents lost to flooring the split count as rounding, not as money held back.
      const held = !fresh && (failedUnder.length || roundedOut.length || splitLeft >= 1) ? splitLeft : 0;
      if (held >= 0.01) {
        const who = [
          failedUnder.length ? `${listJoin(failedUnder)} ${failedUnder.length === 1 ? 'is' : 'are'} under target but can’t be bought this run` : '',
          roundedOut.length ? `${listJoin(roundedOut)} ${roundedOut.length === 1 ? 'was' : 'were'} left out so the whole-percent split could spend more` : '',
        ].filter(Boolean);
        parts.push({
          usd: held,
          text: who.length
            ? `${who.join(', and ')}, and this run puts money only into stocks under their target share`
            : 'this run puts money only into stocks under their target share',
        });
      }
      // Only what sizing really cut (cost limit or swap caps); cents lost to whole dollars count as rounding.
      const cut = cents(trials.filter((t) => t.cutBy).reduce((s2, t) => s2 + (split.find((x) => x.symbol === t.symbol)!.usd - t.usd!), 0));
      if (cut >= 0.01) parts.push({ usd: cut, text: `${listJoin(trials.filter((t) => t.cutBy).map((t) => ticker(t.symbol)))} ${trials.filter((t) => t.cutBy).length === 1 ? 'was' : 'were'} cut to fit your cost limit or the swap caps` });
      const rounded = cents(cashUsd - Math.max(0, held) - Math.max(0, cut));
      if (rounded >= 0.01) parts.push({ usd: rounded, text: 'amounts are rounded down to whole dollars and the basket buy splits in whole percents, so no stock gets more than it was sized for' });
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
        // Nothing held yet and a stock failed its checks: the run went to the others at their weights.
        firstRunNote:
          fresh && failedUnder.length
            ? `${listJoin(failedUnder)} didn’t pass ${failedUnder.length === 1 ? 'its' : 'their'} checks. With nothing held yet, this run buys the others at their weights, and later runs put more into ${listJoin(failedUnder)}.`
            : null,
        // Only what the whole-percent split loses (not whole-dollar cents): this decides the retry below.
        roundingUsd: cents(trials.reduce((s2, t) => s2 + t.usd!, 0) - whole.investedUsd),
        shortfall: null,
        unpriced,
      };
    }
    // Nothing to buy: the ones under target failed, and the rest are at or over their share after this run.
    const why = (s: string) => out.get(s) ?? small.get(s) ?? 'It’s at or over its target share after this run, so this run puts nothing into it.';
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
