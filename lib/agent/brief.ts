// "Describe a basket" on the trade plan (/plan, 2026-11-13): a person gives a theme, sectors to leave
// out, how many stocks to spread over, a budget, cash to keep and the plan's own limits; this code
// picks the stocks, weights and sizes, and says plainly what Base's stocks can't meet. Claude only
// explains the result (lib/agent/explain.ts). The basket is bought through /build's normal basket buy
// (BasketBuyPanel), signed in the person's wallet; nothing here builds a transaction.
//
// Pure: the route passes in the tape, the steady depths (lib/market/depthSamples.ts) and the cost models.
import type { TapeResult } from '../market/tape';
import type { SteadyDepth } from '../market/depthSamples';
import { TAPE_MAIN_DEPTH_USD } from '../market/liquidity';
import { normalizeLegs, type BasketLeg } from '../build/customBasket';
import { STOCKS } from '../stocks/tokens';
import { PROFILES, SECTORS, THEMES, type Sector, type Theme } from '../stocks/sectors';
import { usd } from '../format';
import { BRIEF_LIMITS, PLAN_LIMITS } from './limits';
import { given, screen, sizeLegs, type CostModel, type PlanInput, type PlanLeg } from './plan';

export { BRIEF_LIMITS } from './limits';

export type BriefTheme = Theme | 'Any';

export interface BriefInput {
  theme: BriefTheme;
  exclude: Sector[];
  /** Equal weights, so this is also "no more than 1/N in one company". */
  minStocks: number;
  budgetUsd: number;
  cashPct: number;
  maxPremiumBp: number;
  maxCostBp: number;
  earningsDays: number;
  note: string;
}

export interface BriefStep {
  /** e.g. "with a pool that held over $250k for the last 3 hours" */
  label: string;
  symbols: string[];
}

export interface BriefPick {
  symbol: string;
  name: string;
  weightPct: number;
  usd: number;
  costBp: number;
  gapBp: number | null;
  gapAgainst: string;
  /** Steady depth (lowest over the window), the time of its newest sample and of its oldest. */
  depthUsd: number;
  depthAsOfMs: number;
  depthSinceMs: number | null;
  /** Bought at less than its equal share, and why: the cost limit, or the swap caps ($25k, 10% of the pool). */
  sizedDownBy: 'cost limit' | 'swap caps' | null;
}

export interface Brief {
  input: Omit<BriefInput, 'note'>;
  /** Candidates narrowing step by step: theme → sectors → steady depth → limits → the 4 deepest → budget → cost limit (a later step only when it cuts). */
  steps: BriefStep[];
  /** Why each candidate that didn't make it was dropped, one sentence each. */
  dropped: { symbol: string; why: string }[];
  /** The plan's screened legs (verdicts and reasons), for the stocks that reached the checks. */
  legs: PlanLeg[];
  /** null: no basket, and `shortfall` says why. */
  picks: BriefPick[] | null;
  shortfall: string | null;
  /** When fewer passed than asked but still at least 2: the one-click way out. */
  suggestion: { minStocks: number; text: string } | null;
  investedUsd: number;
  cashUsd: number;
  /** Whole-percent weights for the basket buy (/build spec), in the picks' order. */
  basket: BasketLeg[] | null;
  assumptions: string[];
  session: { state: string; label: string; nextOpenIso: string };
  /** The oldest depth reading behind the shortlist (under 3 hours ago right after a deploy); null if none. */
  readingsSinceMs: number | null;
  createdAt: number;
}

/** Parses the request body; returns the input or a message for a 400 (worded for the form). */
export function parseBriefInput(body: unknown): BriefInput | string {
  if (!body || typeof body !== 'object') return 'expected a JSON object';
  const b = body as Record<string, unknown>;
  const theme = b.theme ?? 'Any';
  if (theme !== 'Any' && !(THEMES as readonly unknown[]).includes(theme)) return 'pick a theme from the list';
  const exclude = b.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.some((s) => !(SECTORS as readonly unknown[]).includes(s))) return 'pick sectors to leave out from the list';
  const num = (v: unknown, lo: number, hi: number, message: string): number | string => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) && n >= lo && n <= hi ? n : message;
  };
  const minStocks = num(given(b.minStocks, 3), BRIEF_LIMITS.minStocks, BRIEF_LIMITS.maxStocks, `spread over ${BRIEF_LIMITS.minStocks} to ${BRIEF_LIMITS.maxStocks} stocks`);
  if (typeof minStocks === 'string') return minStocks;
  if (!Number.isInteger(minStocks)) return `spread over ${BRIEF_LIMITS.minStocks} to ${BRIEF_LIMITS.maxStocks} stocks`;
  const budgetUsd = num(b.budgetUsd, PLAN_LIMITS.minBudgetUsd, BRIEF_LIMITS.maxBudgetUsd, `the budget must be between $${PLAN_LIMITS.minBudgetUsd} and $${BRIEF_LIMITS.maxBudgetUsd.toLocaleString('en-US')} (the most one basket buy can be)`);
  if (typeof budgetUsd === 'string') return budgetUsd;
  const cashPct = num(given(b.cashPct, 0), 0, BRIEF_LIMITS.maxCashPct, `the cash to keep must be between 0% and ${BRIEF_LIMITS.maxCashPct}%`);
  if (typeof cashPct === 'string') return cashPct;
  const maxPremiumBp = num(given(b.maxPremiumBp, 50), 0, PLAN_LIMITS.maxPremiumBp, `the most over the real stock's price must be between 0% and ${PLAN_LIMITS.maxPremiumBp / 100}%`);
  if (typeof maxPremiumBp === 'string') return maxPremiumBp;
  const maxCostBp = num(given(b.maxCostBp, 30), 1, PLAN_LIMITS.maxCostBp, `the most to pay to trade must be between 0.01% and ${PLAN_LIMITS.maxCostBp / 100}%`);
  if (typeof maxCostBp === 'string') return maxCostBp;
  const earningsDays = num(given(b.earningsDays, 2), 0, PLAN_LIMITS.maxEarningsDays, `the earnings wait must be between 0 and ${PLAN_LIMITS.maxEarningsDays} days`);
  if (typeof earningsDays === 'string') return earningsDays;
  const note = b.note ?? '';
  if (typeof note !== 'string') return 'the note must be text';
  if (note.length > PLAN_LIMITS.maxNoteChars) return `the note must be at most ${PLAN_LIMITS.maxNoteChars} characters`;
  return {
    theme: theme as BriefTheme,
    exclude: [...new Set(exclude as Sector[])],
    minStocks,
    budgetUsd,
    cashPct,
    maxPremiumBp,
    maxCostBp,
    earningsDays: Math.floor(earningsDays),
    note: note.trim(),
  };
}

const list = (syms: string[]) => syms.map((s) => s.replace(/c$/, '')).join(', ');
const pctText = (bp: number) => `${Number((bp / 100).toFixed(3))}%`;

/** Steps 1-4: theme, sectors, steady depth, the plan's checks, then the 8 deepest that passed as the
 *  candidates. Shared by the route (which reads cost models for `candidates` only) and buildBrief. */
function shortlist(input: BriefInput, tape: Pick<TapeResult, 'rows' | 'session'>, steady: Map<string, SteadyDepth>, earningsSyncedAt: number | null, now: number) {
  const dropped: Brief['dropped'] = [];
  const themeLabel = input.theme === 'Any' ? 'Any theme' : `Theme “${input.theme}”`;

  const themed = STOCKS.filter((s) => input.theme === 'Any' || PROFILES[s.symbol]?.themes.includes(input.theme)).map((s) => s.symbol);
  const kept = themed.filter((sym) => {
    const sector = PROFILES[sym]?.sector;
    if (sector && input.exclude.includes(sector)) {
      dropped.push({ symbol: sym, why: `${sector}, which you left out.` });
      return false;
    }
    return true;
  });
  const deep = kept.filter((sym) => {
    const d = steady.get(sym);
    if (!d || d.usd == null) {
      dropped.push({ symbol: sym, why: 'Its pool depth over the last 3 hours is unknown (no recent reading), so it is left out.' });
      return false;
    }
    if (d.usd < TAPE_MAIN_DEPTH_USD) {
      dropped.push({ symbol: sym, why: `Its pool read as little as ${usd(d.usd, 0)} in the last 3 hours, under the ${usd(TAPE_MAIN_DEPTH_USD, 0)} a basket needs.` });
      return false;
    }
    return true;
  });

  // The plan's own checks (gap, a stale pool, earnings), on the steady depth rather than one read.
  const planInput: PlanInput = { symbols: deep, budgetUsd: input.budgetUsd, maxPremiumBp: input.maxPremiumBp, maxCostBp: input.maxCostBp, earningsDays: input.earningsDays, note: '' };
  // Never call screen() with no stocks: the plan reads an empty list as "the deepest pools", which would
  // fill a health-care brief with tech (caught on live data, 2026-11-13).
  const legs = (deep.length ? screen(planInput, tape, earningsSyncedAt, now) : []).filter((l) => deep.includes(l.symbol))
    .map((l) => ({ ...l, depthUsd: Math.min(l.depthUsd ?? Infinity, steady.get(l.symbol)!.usd!) }));
  for (const l of legs) if (l.verdict !== 'buy') dropped.push({ symbol: l.symbol, why: l.decidedBy ?? l.reasons[0] ?? 'It didn’t pass your limits.' });

  // Deepest steady pool first (a fact about how well a buy fills, not a view on the stock); ties by symbol.
  const passing = legs
    .filter((l) => l.verdict === 'buy')
    .sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0) || a.symbol.localeCompare(b.symbol));
  // The basket is built from the deepest of these, in order: the 4 it holds plus as many again, so a
  // stock the cost limit drops is replaced by the next deepest (review of PR #172, 2026-11-13). The
  // route reads cost models for exactly these; buildBrief says why each one past them is left out.
  const candidates = passing.slice(0, BRIEF_LIMITS.maxCandidates);

  return { dropped, themeLabel, themed, kept, deep, planInput, legs, passing, candidates };
}

const CAP_WHY = `A basket holds at most ${BRIEF_LIMITS.maxStocks} stocks, and ${BRIEF_LIMITS.maxStocks} with deeper pools made it.`;

/** The stocks the route needs cost models for. */
export function briefShortlist(input: BriefInput, tape: Pick<TapeResult, 'rows' | 'session'>, steady: Map<string, SteadyDepth>, earningsSyncedAt: number | null, now = Date.now()): string[] {
  return shortlist(input, tape, steady, earningsSyncedAt, now).candidates.map((l) => l.symbol);
}

/** Builds the basket. `steady` maps symbol → steady depth (missing = unknown). */
export function buildBrief(
  input: BriefInput,
  tape: Pick<TapeResult, 'rows' | 'session'>,
  steady: Map<string, SteadyDepth>,
  costs: Map<string, CostModel | null>,
  earningsSyncedAt: number | null,
  feeBps = 0,
  now = Date.now(),
): Brief {
  const { dropped, themeLabel, themed, kept, deep, planInput, legs, passing, candidates } = shortlist(input, tape, steady, earningsSyncedAt, now);
  const passingSymbols = passing.map((l) => l.symbol);
  // Whole cents first, so $19.99 with no cash is $19.99, not $19.98 (float error under the floor).
  const investedTarget = Math.floor(Math.round(input.budgetUsd * 100) * (1 - input.cashPct / 100) + 1e-6) / 100;
  const skipLeg = (l: PlanLeg, why: string) => {
    l.verdict = 'skip';
    l.decidedBy = why;
    l.reasons.push(why);
    dropped.push({ symbol: l.symbol, why });
  };

  // A small budget takes fewer stocks (deepest first): each needs at least the $10 swap minimum, and
  // taking 4 regardless split $20 into four $5 legs that were all dropped (external review, 2026-11-13).
  // The same split the basket uses (equal shares, whole-percent weights, the total lowered to fit them):
  // $30 over 3 is 34/33/33 of $29, under $10 for two of them, so it covers 2 (external review).
  const covers = (n: number) => {
    if (n < 1) return true;
    const share = Math.floor(investedTarget / n);
    const w = normalizeLegs(Array.from({ length: n }, (_, i) => ({ symbol: String(i), weight: 1 }))).map((l) => l.weightPct);
    const total = Math.floor(Math.min(...w.map((x) => (share * 100) / x)));
    return Math.min(...w.map((x) => Math.floor(total * x) / 100)) >= PLAN_LIMITS.minLegUsd;
  };
  let byBudget = Math.min(BRIEF_LIMITS.maxStocks, Math.max(0, Math.floor(investedTarget / PLAN_LIMITS.minLegUsd)));
  while (byBudget > 0 && !covers(byBudget)) byBudget--;
  const budgetWhy = `Your ${usd(investedTarget)} to invest covers at most ${byBudget} ${byBudget === 1 ? 'stock' : 'stocks'} at the ${usd(PLAN_LIMITS.minLegUsd, 0)} minimum each.`;
  const budgetShort = byBudget < input.minStocks && candidates.length >= input.minStocks;

  // Size with the plan's caps and the cost limit, equal shares, deepest first. A stock the sizing drops
  // (the cost limit, or a pool that couldn't be read) is replaced by the next deepest candidate and the
  // basket is sized again, so it isn't left smaller than it could be (review of PR #172, 2026-11-13).
  const queue = [...candidates];
  let current: PlanLeg[] = [];
  /** Dropped by the sizing: over the cost limit (a cost model was read), or with no readable pool. */
  const sizeDropped: string[] = [];
  const costDropped: string[] = [];
  const tried = new Map<string, PlanLeg>();
  let sized: PlanLeg[] = [];
  let sizedRan = false;
  for (;;) {
    while (current.length < byBudget && queue.length) current.push(queue.shift()!);
    // Sized even when fewer are left than the spread asked for, so a shortfall only names stocks that fit.
    if (!current.length) break;
    const trial = current.map((l) => ({ ...l, reasons: [...l.reasons] }));
    sizeLegs(trial, { ...planInput, budgetUsd: investedTarget }, costs, feeBps);
    for (const t of trial) tried.set(t.symbol, t);
    const failed = trial.filter((l) => l.verdict !== 'buy' || !((l.usd ?? 0) > 0));
    if (!failed.length) {
      sized = trial;
      sizedRan = true;
      break;
    }
    for (const t of failed) {
      skipLeg(current.find((l) => l.symbol === t.symbol)!, t.decidedBy ?? 'It didn’t pass your limits.');
      sizeDropped.push(t.symbol);
      if (costs.get(t.symbol)) costDropped.push(t.symbol);
    }
    current = current.filter((l) => l.verdict === 'buy');
  }
  // Stocks never sized. With the basket full, it was the cap or the budget. Otherwise every candidate was
  // tried, and these are past the deepest few the cost limit is tried on; never say "deeper pools made it"
  // when none did (caught on live data with a 0.01% limit).
  const unreadable = sizeDropped.filter((s) => !costDropped.includes(s));
  // Full, or the budget alone decided (it covers fewer than 4 and nothing was dropped by sizing, or none at all).
  const full = (sizedRan && sized.length >= byBudget) || byBudget === 0 || (byBudget < BRIEF_LIMITS.maxStocks && !sizeDropped.length);
  const fullWhy = byBudget < BRIEF_LIMITS.maxStocks ? budgetWhy : CAP_WHY;
  for (const l of queue) skipLeg(l, fullWhy);
  for (const l of passing.slice(BRIEF_LIMITS.maxCandidates)) {
    skipLeg(l, full ? fullWhy : `Only the ${BRIEF_LIMITS.maxCandidates} deepest stocks that passed are tried against your cost limit; this one comes after them.`);
  }
  const lastTrial = [...tried.values()];
  // The basket buy splits by whole-percent weights, so a stock that rounds to 0% would silently drop
  // out of it (real-money review, 2026-11-13): drop it here, with its reason, before anything is shown.
  while (sized.length) {
    const weights = normalizeLegs(sized.map((l) => ({ symbol: l.symbol, weight: l.usd ?? 0 })));
    const zero = sized.filter((l) => !weights.some((w) => w.symbol === l.symbol));
    // The same split the basket below uses: a stock it would cut under the plan's per-swap minimum goes too.
    const w = (sym: string) => weights.find((x) => x.symbol === sym)?.weightPct ?? 0;
    const total = zero.length ? 0 : Math.floor(Math.min(...sized.map((l) => ((l.usd ?? 0) * 100) / w(l.symbol))));
    const tiny = zero.length ? [] : sized.filter((l) => Math.floor(total * w(l.symbol)) / 100 < PLAN_LIMITS.minLegUsd);
    if (!zero.length && !tiny.length) break;
    for (const l of zero.length ? zero : tiny.slice(0, 1)) {
      skipLeg(
        l,
        zero.length
          ? `Its ${usd(l.usd ?? 0, 0)} is under 1% of the basket, too small to be a whole-percent part of it.`
          : `Its share of the basket would be under the ${usd(PLAN_LIMITS.minLegUsd, 0)} minimum for a swap.`,
      );
    }
    sized = sized.filter((l) => l.verdict === 'buy');
  }

  // Sizing ran on copies: write the outcome back, so the legs the API returns say what was sized or dropped.
  for (const t of lastTrial) {
    const l = legs.find((x) => x.symbol === t.symbol);
    if (l) Object.assign(l, { verdict: t.verdict, decidedBy: t.decidedBy, reasons: t.reasons, usd: t.usd, shares: t.shares, costBp: t.costBp, cutBy: t.cutBy });
  }
  // What "passed": the sized legs once sizing ran, else the ones that passed the checks.
  const passed = sizedRan ? sized : current;
  // The oldest depth reading behind the shortlist: right after a deploy it is minutes, not 3 hours.
  // The shortest history behind the deep stocks (the newest first reading), so "since" is never overstated.
  const since = (deep.length ? deep : kept).map((sym) => steady.get(sym)?.sinceMs).filter((t): t is number => t != null);
  const readingsSinceMs = since.length ? Math.max(...since) : null;
  // Every stock that passed the checks is counted, then each later cut gets its own step, so "4 passed"
  // never stands for "15 passed and the 4 deepest were kept" (external review of the live page, 2026-11-13).
  const steps: BriefStep[] = [
    { label: `${themeLabel}: stocks on Afterbook`, symbols: themed },
    ...(input.exclude.length ? [{ label: 'after the sectors you left out', symbols: kept }] : []),
    { label: `with a pool over ${usd(TAPE_MAIN_DEPTH_USD, 0)} in every reading of the last 3 hours`, symbols: deep },
    { label: 'that pass your price and earnings limits', symbols: passingSymbols },
  ];
  const addStep = (label: string, symbols: string[]) => {
    if (symbols.length !== steps[steps.length - 1].symbols.length) steps.push({ label, symbols });
  };
  // Each step is a subset of the one before: the deepest stocks sized against the cost limit (in depth
  // order, the next one taking a dropped one's place), those within it, then those over the swap minimum.
  const triedSymbols = passingSymbols.filter((s) => tried.has(s));
  // Nothing sized (a budget that covers no stock): none of the sizing steps, which would read as "0 pools
  // could be read" (review of PR #176); the shortfall says why.
  if (triedSymbols.length) {
    addStep(
      sizeDropped.length
        ? `the ${triedSymbols.length} with the deepest pools, tried in turn against your cost limit`
        : byBudget < BRIEF_LIMITS.maxStocks
        ? `the ${triedSymbols.length} with the deepest pools that your budget covers at ${usd(PLAN_LIMITS.minLegUsd, 0)} or more each`
        : `the ${triedSymbols.length} with the deepest pools (a basket holds at most ${BRIEF_LIMITS.maxStocks})`,
      triedSymbols,
    );
    // An unreadable pool is not a cost-limit drop: its own step, so "within your cost limit" counts only those.
    addStep('with a pool that could be read just now', triedSymbols.filter((s) => !unreadable.includes(s)));
    addStep('within your cost limit', triedSymbols.filter((s) => !sizeDropped.includes(s)));
    addStep(`over the ${usd(PLAN_LIMITS.minLegUsd, 0)} swap minimum`, passed.map((l) => l.symbol));
  }

  const base = {
    input: { theme: input.theme, exclude: input.exclude, minStocks: input.minStocks, budgetUsd: input.budgetUsd, cashPct: input.cashPct, maxPremiumBp: input.maxPremiumBp, maxCostBp: input.maxCostBp, earningsDays: input.earningsDays },
    steps,
    dropped,
    legs,
    session: { state: tape.session.state, label: tape.session.label, nextOpenIso: tape.session.nextOpenIso },
    readingsSinceMs,
    createdAt: now,
  };

  if (passed.length < input.minStocks) {
    const n = passed.length;
    // Every candidate's depth unknown: the readings are missing (just deployed, or the cron is down),
    // which is not the same as Base having no deep pools. Say which.
    const noReadings = kept.length > 0 && kept.every((sym) => steady.get(sym)?.usd == null);
    const shortfall =
      n === 0 && noReadings
        ? 'Afterbook has no recent pool-depth readings just now, so it can’t tell which pools are deep enough. Try again in a few minutes.'
        : budgetShort
        ? `Your ${usd(investedTarget)} to invest is too little for at least ${usd(PLAN_LIMITS.minLegUsd, 0)} in each of ${input.minStocks} stocks. Raise the budget or keep less as cash.${
            // Both reasons when both applied (review of PR #175: $36 with 29% cash, 7 of 8 also over the cost limit).
            costDropped.length ? ` Your ${pctText(input.maxCostBp)} cost limit also left out ${list(costDropped)}.` : ''
          }${unreadable.length ? ` The ${unreadable.length === 1 ? 'pool' : 'pools'} of ${list(unreadable)} couldn’t be read just now.` : ''}`
        : n === 0 && costDropped.length && feeBps >= input.maxCostBp
        ? `Afterbook’s ${pctText(feeBps)} swap fee alone is over your ${pctText(input.maxCostBp)} limit on what you’ll pay to trade, so there is no basket.`
        : n === 0 && costDropped.length
        ? // Not "no stock meets this brief": the person's own cost limit is what stopped it (review of PR #172).
          costDropped.length === sizeDropped.length
          ? `Your ${pctText(input.maxCostBp)} limit on what you’ll pay to trade leaves out every stock it was tried on (${list(costDropped)}): even a ${usd(PLAN_LIMITS.minLegUsd, 0)} buy in each would cost more than that. A higher limit lets more through.`
          : `Your ${pctText(input.maxCostBp)} limit on what you’ll pay to trade leaves out ${list(costDropped)}, and the pools of ${list(unreadable)} couldn’t be read just now, so there is no basket.`
        : n === 0
        ? `No stock on Base meets this brief right now, so there is nothing to buy.`
        : `${n === 1 ? 'Only 1 stock passes' : `${n} stocks pass`} (${list(passed.map((l) => l.symbol))})${costDropped.length ? `, your ${pctText(input.maxCostBp)} cost limit left out ${list(costDropped)},` : ''} and you asked to spread over at least ${input.minStocks}, so there is no basket.`;
    const suggestion = n >= BRIEF_LIMITS.minStocks ? { minStocks: n, text: `${n} passed. Spread over at least ${n}?` } : null;
    return { ...base, picks: null, shortfall, suggestion, investedUsd: 0, cashUsd: input.budgetUsd, basket: null, assumptions: [] };
  }

  // Whole-percent weights can't hold equal thirds (34/33/33), so sizing the total as the sum of the legs
  // would give the 34% stock more than it was sized for, possibly past the person's cost limit
  // (real-money review, 2026-11-13). Instead the total is lowered until no stock gets more than its sized
  // amount, and each pick shows exactly what the basket buy will split (to the cent).
  const basket = normalizeLegs(sized.map((l) => ({ symbol: l.symbol, weight: l.usd ?? 0 })));
  const weightOf = (sym: string) => basket.find((b) => b.symbol === sym)!.weightPct;
  const investedUsd = Math.floor(Math.min(...sized.map((l) => ((l.usd ?? 0) * 100) / weightOf(l.symbol))));
  const picks: BriefPick[] = sized.map((l) => {
    const d = steady.get(l.symbol)!;
    const legUsd = Math.floor(investedUsd * weightOf(l.symbol)) / 100;
    const model = costs.get(l.symbol);
    return {
      symbol: l.symbol,
      name: l.name,
      weightPct: weightOf(l.symbol),
      usd: legUsd,
      // At most the sized amount, so at most its cost; re-estimated at the amount actually bought.
      costBp: model ? model.estimate(legUsd).impactBp + feeBps : (l.costBp ?? 0),
      gapBp: l.gapBp,
      gapAgainst: l.gapAgainst,
      depthUsd: l.depthUsd ?? 0,
      depthAsOfMs: d.asOfMs!,
      depthSinceMs: d.sinceMs ?? null,
      // Set by sizeLegs itself (not read back from its wording), so the cash sentence names the real cause.
      sizedDownBy: l.cutBy ?? null,
    };
  });
  const assumptions = [
    'About equal amounts in each stock: none is favoured. Weights are whole percents, so they can differ by up to a point; a stock gets less only where that, a cap or your cost limit needs it, and that money stays as cash.',
    'Sized at the pool prices just read. Each swap is rebuilt and checked again before you sign, and stops if the price moved too far.',
    ...(tape.session.state.startsWith('closed') ? ['The US market is closed, so each gap is against the last close and can move when it reopens.'] : []),
  ];
  return {
    ...base,
    picks,
    shortfall: null,
    suggestion: null,
    investedUsd,
    cashUsd: Math.round((input.budgetUsd - investedUsd) * 100) / 100,
    basket,
    assumptions,
  };
}

/** The explanation used when Claude isn't configured or doesn't answer: the same facts, fixed words. */
export function fallbackBriefExplanation(brief: Brief): string {
  const parts: string[] = [];
  if (brief.picks) {
    parts.push(
      `Your basket: ${brief.picks.map((p) => `${p.symbol.replace(/c$/, '')} ${usd(p.usd, 0)}`).join(', ')}, ${usd(brief.investedUsd, 0)} in all, with ${usd(brief.cashUsd, 0)} kept as cash.`,
    );
    parts.push('The deepest pools that passed your limits come first, with equal amounts in each.');
  } else {
    parts.push(brief.shortfall ?? 'Nothing passes your limits right now.');
    if (brief.suggestion) parts.push(brief.suggestion.text);
  }
  if (brief.session.state.startsWith('closed')) parts.push('The US market is closed, so each gap is against the last close and can move when it reopens.');
  if (brief.dropped.length) parts.push(`Why ${brief.picks ? 'each other' : 'each'} stock was left out is listed below.`);
  parts.push('Nothing is bought until you review the basket and sign each step in your wallet.');
  return parts.join(' ');
}
