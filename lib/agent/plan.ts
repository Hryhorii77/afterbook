// The trade plan (owner, 2026-11-08): a person gives stocks, a budget and their own limits; this code
// decides, for each stock, "review a buy", "wait" or "skip", and sizes the buys. Claude only explains
// the result in words (lib/agent/explain.ts); it never changes a verdict or a number. Any buy still goes
// through the normal swap panel and its checks (lib/swap/swap.ts) and is signed in the person's wallet.
//
// Pure: the route (app/api/agent/plan/route.ts) passes in the tape and the fill-cost estimates.
import type { TapeResult, TapeRow } from '../market/tape';
import { todayReference } from '../market/todaySnapshot';
import { TAPE_MAIN_DEPTH_USD } from '../market/liquidity';
import { MAX_SWAP_USD, MAX_BUY_DEPTH_SHARE } from '../swap/swap';
import { gapSizeText, gapVsText, usd, formatNextOpen } from '../format';
import { PLAN_LIMITS } from './limits';

/** A cost in bp as the person typed it on the form: a percent ("0.3%"), not bp (external review, 2026-11-13). */
const costPct = (bp: number) => `${Number((bp / 100).toFixed(3))}%`;

export { PLAN_LIMITS } from './limits';

export interface PlanInput {
  /** Empty: let the plan pick the deepest pools. */
  symbols: string[];
  budgetUsd: number;
  /** The most the onchain price may sit above the cash price, in bp. */
  maxPremiumBp: number;
  /** The most a fill may cost (price impact plus the pool fee), in bp. */
  maxCostBp: number;
  /** Wait if the company reports earnings within this many days (0: ignore earnings). */
  earningsDays: number;
  /** Free text for the explanation only; it never reaches the numbers. */
  note: string;
}

export type Verdict = 'buy' | 'wait' | 'skip';

/** Turn a leg into a wait or skip for `reason`. The first reason that blocked it is the one recorded. */
function block(leg: PlanLeg, verdict: Exclude<Verdict, 'buy'>, reason: string): void {
  leg.verdict = verdict;
  leg.reasons.push(reason);
  leg.decidedBy ??= reason;
}

export interface PlanLeg {
  symbol: string;
  name: string;
  verdict: Verdict;
  /** Plain sentences, written here from the numbers, shown as they are. */
  reasons: string[];
  /** For a wait or skip, the reason that decided it (one of `reasons`); the others are context only.
   *  Kept apart so Claude can't present a warning as the cause (it did, live, 2026-11-08). */
  decidedBy?: string;
  /** Set by sizeLegs when the buy is less than its equal share: the cost limit, or the swap caps ($25k, 10% of the pool). */
  cutBy?: 'cost limit' | 'swap caps';
  gapBp: number | null;
  /** "close", "price", "after-hours price"…: what the gap is measured against. */
  gapAgainst: string;
  priceUsd: number | null;
  depthUsd: number | null;
  /** Buys only. */
  usd?: number;
  shares?: number;
  costBp?: number;
}

export interface Plan {
  legs: PlanLeg[];
  budgetUsd: number;
  plannedUsd: number;
  session: { state: string; label: string; nextOpenIso: string };
  createdAt: number;
}

/** Parses the request body; returns the input or a message for a 400. */
export function parsePlanInput(body: unknown, known: (symbol: string) => boolean): PlanInput | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const symbols = b.symbols ?? [];
  if (!Array.isArray(symbols) || symbols.some((s) => typeof s !== 'string')) return 'the stocks must be a list of symbols';
  const uniq = [...new Set(symbols as string[])];
  if (uniq.length > PLAN_LIMITS.maxSymbols) return `at most ${PLAN_LIMITS.maxSymbols} stocks`;
  const unknown = uniq.find((s) => !known(s));
  if (unknown) return `unknown symbol: ${unknown.slice(0, 20)}`;
  // Messages are read by people on the page, so they name the form's fields, not the JSON keys.
  const num = (v: unknown, lo: number, hi: number, message: string): number | string => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < lo || n > hi) return message;
    return n;
  };
  const budgetUsd = num(b.budgetUsd, PLAN_LIMITS.minBudgetUsd, PLAN_LIMITS.maxBudgetUsd, `the budget must be between $${PLAN_LIMITS.minBudgetUsd} and $${PLAN_LIMITS.maxBudgetUsd.toLocaleString('en-US')}`);
  if (typeof budgetUsd === 'string') return budgetUsd;
  const maxPremiumBp = num(b.maxPremiumBp ?? 50, 0, PLAN_LIMITS.maxPremiumBp, `the most you'll pay over the real stock must be between 0% and ${PLAN_LIMITS.maxPremiumBp / 100}%`);
  if (typeof maxPremiumBp === 'string') return maxPremiumBp;
  const maxCostBp = num(b.maxCostBp ?? 30, 1, PLAN_LIMITS.maxCostBp, `the most you'll pay to trade must be between 0.01% and ${PLAN_LIMITS.maxCostBp / 100}%`);
  if (typeof maxCostBp === 'string') return maxCostBp;
  const earningsDays = num(b.earningsDays ?? 2, 0, PLAN_LIMITS.maxEarningsDays, `the earnings wait must be between 0 and ${PLAN_LIMITS.maxEarningsDays} days`);
  if (typeof earningsDays === 'string') return earningsDays;
  const note = b.note ?? '';
  if (typeof note !== 'string') return 'the note must be text';
  if (note.length > PLAN_LIMITS.maxNoteChars) return `the note must be at most ${PLAN_LIMITS.maxNoteChars} characters`;
  return { symbols: uniq, budgetUsd, maxPremiumBp, maxCostBp, earningsDays: Math.floor(earningsDays), note: note.trim() };
}

/** Whole days from the New York date `todayKey` to `isoDate` (both YYYY-MM-DD). */
function daysUntil(todayKey: string, isoDate: string): number {
  return Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000);
}

/** The stocks a plan looks at: the ones asked for, or the deepest pools with a fresh price. */
export function pickRows(input: PlanInput, tape: Pick<TapeResult, 'rows'>): TapeRow[] {
  if (input.symbols.length) return input.symbols.map((s) => tape.rows.find((r) => r.symbol === s)).filter((r): r is TapeRow => !!r);
  return [...tape.rows]
    .filter((r) => r.onchainMidUsd != null && !r.cashStale && (r.depthUsd ?? 0) >= TAPE_MAIN_DEPTH_USD)
    .sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0))
    .slice(0, PLAN_LIMITS.anyCount);
}

/** How old the earnings job's last full scan may be for "no date" to mean "no report in the window":
 *  it runs daily, so 36 hours allows one late run. */
export const EARNINGS_FRESH_MS = 36 * 3_600_000;

/** Step 1: the checks that don't depend on size. Legs still marked 'buy' go on to sizing.
 *  `earningsSyncedAt` is when the earnings job last scanned its whole window without a failed day
 *  (lib/stocks/earningsCalendar.ts), or null if never or unknown. */
export function screen(
  input: PlanInput,
  tape: Pick<TapeResult, 'rows' | 'session'>,
  earningsSyncedAt: number | null = null,
  now = Date.now(),
): PlanLeg[] {
  const calendarFresh = earningsSyncedAt != null && now - earningsSyncedAt >= 0 && now - earningsSyncedAt < EARNINGS_FRESH_MS;
  return pickRows(input, tape).map((row) => {
    const ref = todayReference(row, tape.session);
    const leg: PlanLeg = {
      symbol: row.symbol,
      name: row.name,
      verdict: 'buy',
      reasons: [],
      gapBp: ref.bp,
      gapAgainst: ref.word,
      priceUsd: row.onchainMidUsd,
      depthUsd: row.depthUsd,
    };
    if (row.onchainMidUsd == null || ref.bp == null || row.cashStale) {
      block(leg, 'skip', 'No fresh onchain or cash price right now, so the gap can’t be checked.');
      return leg;
    }
    if ((row.depthUsd ?? 0) < TAPE_MAIN_DEPTH_USD) {
      block(leg, 'skip', `The pool holds ${usd(row.depthUsd ?? 0, 0)}, under the ${usd(TAPE_MAIN_DEPTH_USD, 0)} this plan needs to size a trade.`);
      return leg;
    }
    const gapText = `${gapVsText(ref.bp)} the cash ${ref.word}`;
    if (Math.abs(ref.bp) > PLAN_LIMITS.maxAbsGapBp) {
      // A gap this wide (BILIc read 9% below on 2026-11-08) is more often a stale pool or news than a
      // bargain: say so rather than let a discount pass as "inside your limit".
      block(leg, 'wait', `The token trades ${gapText}, over ${gapSizeText(PLAN_LIMITS.maxAbsGapBp)} either way: the pool’s price may be stale, or something happened to the stock. Check it before buying.`);
    } else if (ref.bp > input.maxPremiumBp) {
      block(leg, 'wait', `The token trades ${gapText}, more than the ${gapSizeText(input.maxPremiumBp)} you set.`);
    } else {
      leg.reasons.push(`The token trades ${gapText}, inside your ${gapSizeText(input.maxPremiumBp)} limit.`);
    }
    if (input.earningsDays > 0 && !row.nextEarningsDate) {
      // The earnings job scans 15 days ahead (EARNINGS_SCAN_DAYS), so after a recent full scan no date
      // means no report in any wait the form offers. If the last full scan is old or a day failed,
      // absence proves nothing: say so (from a review, 2026-11-08).
      leg.reasons.push(
        calendarFresh
          ? `${row.cashTicker} has no earnings report on the calendar in the next ${PLAN_LIMITS.maxEarningsDays} days.`
          : `Couldn’t confirm ${row.cashTicker}’s earnings date: the calendar wasn’t fully checked in the last 36 hours. Check it before buying.`,
      );
    }
    if (input.earningsDays > 0 && row.nextEarningsDate) {
      const days = daysUntil(tape.session.dateKey, row.nextEarningsDate);
      if (days >= 0 && days <= input.earningsDays) {
        const why = `${row.cashTicker} reports earnings ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} (${row.nextEarningsDate}); you asked to wait within ${input.earningsDays} days.`;
        if (leg.verdict === 'buy') block(leg, 'wait', why);
        else leg.reasons.push(why);
      }
    }
    return leg;
  });
}

/** The fill-cost model for one stock (lib/market/lotQuote.ts BuyQuoter, trimmed). */
export interface CostModel {
  estimate: (usdcIn: number) => { sharesOut: number; impactBp: number; largeTradeCaveat?: boolean };
  sizeForImpact: (targetBp: number) => number;
}

/** Step 2: split the budget equally over the legs that passed, within the swap's own caps and the
 *  person's cost limit. `feeBps` is Afterbook's own swap fee (lib/swap/swap.ts swapFee, 0 while off),
 *  counted in the cost so the plan never looks cheaper than the swap. Mutates and returns the legs. */
export function sizeLegs(legs: PlanLeg[], input: PlanInput, costs: Map<string, CostModel | null>, feeBps = 0): PlanLeg[] {
  const buys = legs.filter((l) => l.verdict === 'buy');
  if (!buys.length) return legs;
  const share = input.budgetUsd / buys.length;
  if (share < PLAN_LIMITS.minLegUsd) {
    for (const leg of buys) {
      block(leg, 'skip', `Your ${usd(input.budgetUsd, 0)} split over ${buys.length} stocks is ${usd(share)} each, under the ${usd(PLAN_LIMITS.minLegUsd, 0)} minimum for a swap. Pick fewer stocks or raise the budget.`);
    }
    return legs;
  }
  if (feeBps >= input.maxCostBp) {
    for (const leg of buys) {
      block(leg, 'skip', `Afterbook’s ${costPct(feeBps)} swap fee alone is over your ${costPct(input.maxCostBp)} limit.`);
    }
    return legs;
  }
  const poolLimitBp = input.maxCostBp - feeBps;
  for (const leg of buys) {
    const model = costs.get(leg.symbol);
    if (!model) {
      block(leg, 'skip', 'The pool’s liquidity couldn’t be read just now, so the fill cost is unknown.');
      continue;
    }
    const depthCap = (leg.depthUsd ?? 0) * MAX_BUY_DEPTH_SHARE;
    let size = Math.min(share, MAX_SWAP_USD, depthCap);
    const capped = size < share;
    let est = model.estimate(size);
    let shrunk = false;
    if (est.impactBp > poolLimitBp || est.largeTradeCaveat) {
      size = Math.min(size, model.sizeForImpact(poolLimitBp) * 0.98);
      est = model.estimate(size);
      shrunk = true;
    }
    if (size < PLAN_LIMITS.minLegUsd || est.impactBp > poolLimitBp) {
      block(leg, 'skip', `Even a ${usd(PLAN_LIMITS.minLegUsd, 0)} buy would cost more than your ${costPct(input.maxCostBp)} limit to trade in this pool.`);
      continue;
    }
    size = Math.floor(size);
    est = model.estimate(size);
    leg.usd = size;
    leg.shares = est.sharesOut;
    leg.costBp = est.impactBp + feeBps;
    leg.reasons.push(
      feeBps > 0
        ? `A ${usd(size, 0)} buy would cost about ${costPct(leg.costBp)}: ${costPct(est.impactBp)} of price impact and pool fee, plus Afterbook’s ${costPct(feeBps)} fee.`
        : `A ${usd(size, 0)} buy would cost about ${costPct(est.impactBp)} (price impact plus the pool fee; Afterbook charges no fee).`,
    );
    leg.cutBy = shrunk ? 'cost limit' : capped ? 'swap caps' : undefined;
    if (shrunk) leg.reasons.push(`Sized down from ${usd(share, 0)} to stay inside your ${costPct(input.maxCostBp)} limit to trade.`);
    else if (capped) leg.reasons.push(`Capped at ${usd(size, 0)}: one swap is at most ${usd(MAX_SWAP_USD, 0)} and 10% of the pool.`);
  }
  return legs;
}

export function summarize(legs: PlanLeg[], input: PlanInput, session: TapeResult['session'], now = Date.now()): Plan {
  return {
    legs,
    budgetUsd: input.budgetUsd,
    plannedUsd: legs.reduce((s, l) => s + (l.verdict === 'buy' ? (l.usd ?? 0) : 0), 0),
    session: { state: session.state, label: session.label, nextOpenIso: session.nextOpenIso },
    createdAt: now,
  };
}

/** The explanation used when Claude isn't configured or doesn't answer: the same facts, fixed words. */
export function fallbackExplanation(plan: Plan): string {
  const buys = plan.legs.filter((l) => l.verdict === 'buy');
  const waits = plan.legs.filter((l) => l.verdict === 'wait');
  const skips = plan.legs.filter((l) => l.verdict === 'skip');
  const parts: string[] = [];
  if (buys.length) parts.push(`${buys.length === 1 ? 'One buy passes' : `${buys.length} buys pass`} your limits: ${buys.map((l) => `${l.symbol} ${usd(l.usd ?? 0, 0)}`).join(', ')}, ${usd(plan.plannedUsd, 0)} of your ${usd(plan.budgetUsd, 0)}.`);
  else parts.push('Nothing passes your limits right now.');
  if (waits.length) parts.push(`Wait on ${waits.map((l) => l.symbol).join(', ')}.`);
  if (skips.length) parts.push(`Skip ${skips.map((l) => l.symbol).join(', ')}.`);
  if (plan.session.state.startsWith('closed')) parts.push(`The US market is closed, so each gap is against the last close and can move when cash reopens ${formatNextOpen(plan.session.nextOpenIso)}.`);
  parts.push('Each reason is listed under the stock. Nothing is bought until you review it and sign in your wallet.');
  return parts.join(' ');
}
