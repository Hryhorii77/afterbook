// The trade plan and the basket brief, as the routes run them: read the tape, size with the pool cost
// models, explain with Claude when the limits allow (fixed words otherwise), count the plan. Shared by
// the free page routes (/api/agent/plan, /api/agent/brief) and the paid agent routes
// (/api/v1/x402/plan, /api/v1/x402/basket), so a paid plan runs exactly the same checks. Read-only:
// nothing here builds anything a wallet could sign.
import 'server-only';
import { getTape } from '../market/tape';
import { getBuyQuoter } from '../market/lotQuote';
import { getRecentDepthSamples, steadyDepth, type SteadyDepth } from '../market/depthSamples';
import { getStock } from '../stocks/tokens';
import { swapFee } from '../swap/swap';
import { getEarningsSyncedAt } from '../stocks/earningsCalendar';
import { screen, sizeLegs, summarize, fallbackExplanation, type CostModel, type PlanInput, type PlanLeg } from './plan';
import { briefShortlist, buildBrief, fallbackBriefExplanation, type BriefInput } from './brief';
import { explainPlan, explainBrief } from './explain';
import { whyNotExplain } from './explainGate';
import { countPlanBriefly } from './planStats';
import { recheckInput, savedBuys, cappedBuys, basketRecheck, type SavedPlan, type RecheckedBuy } from './planLink';

// Each pool read in a brief gets this long; one the RPC is slow on counts as unreadable (the brief then
// says so, or the next deepest stock takes its place), so a slow RPC can't hold the request until Vercel
// cuts it off (review of PR #175).
const QUOTE_TIMEOUT_MS = 8_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** The plan's checks and sizes (no explanation, nothing counted): `screen` then `sizeLegs` on the live
 *  tape. runPlan uses it, and so does the saved-plan page's recheck with `budgets`: then each stock is
 *  sized on its own against its saved amount (so a fresh size is never more than the link showed, and
 *  its reasons name the amount offered), instead of an equal split of `input.budgetUsd`. */
export async function checkPlan(input: PlanInput, budgets?: Map<string, number>) {
  const tape = await getTape();
  const legs = screen(input, tape, await getEarningsSyncedAt());
  const costs = new Map<string, CostModel | null>();
  await Promise.all(
    legs
      .filter((l) => l.verdict === 'buy')
      .map(async (l) => {
        const stock = getStock(l.symbol);
        costs.set(l.symbol, stock ? await withTimeout(getBuyQuoter(stock), QUOTE_TIMEOUT_MS).catch(() => null) : null);
      }),
  );
  const fee = swapFee()?.bps ?? 0;
  if (budgets) {
    for (const leg of legs) {
      const budgetUsd = budgets.get(leg.symbol);
      // The recheck's input names only the budgeted stocks, so every leg has one.
      if (budgetUsd != null) sizeLegs([leg], { ...input, budgetUsd }, costs, fee);
    }
    return { legs, session: tape.session };
  }
  return { legs: sizeLegs(legs, input, costs, fee), session: tape.session };
}

export interface RunOptions {
  /** An x402 call (counted apart, for traction). */
  paid?: boolean;
  /** false: fixed words, no Claude call (the free MCP tools, so they can't run up the Claude bill). */
  explain?: boolean;
}

/** Throws when the tape or a read fails. */
export async function runPlan(input: PlanInput, request: Request, { paid = false, explain = true }: RunOptions = {}) {
  const { legs, session } = await checkPlan(input);
  const plan = summarize(legs, input, session);
  const blocked = explain ? await whyNotExplain(request) : 'not-requested';
  const explained = blocked ? { text: null, why: blocked } : await explainPlan(plan, input);
  await countPlanBriefly({ explainedBy: explained.text != null ? 'claude' : 'fixed', buys: plan.legs.filter((l) => l.verdict === 'buy').length, paid });
  return {
    plan,
    explanation: explained.text ?? fallbackExplanation(plan),
    explainedBy: explained.text != null ? ('claude' as const) : ('fixed' as const),
    // Why the fixed words were used (a hit limit vs. a reply the checks refused), null when Claude explained it.
    fixedBecause: explained.text != null ? null : explained.why,
  };
}

export async function runBrief(input: BriefInput, request: Request, { paid = false, explain = true }: RunOptions = {}) {
  const now = Date.now();
  const [tape, samples, earningsSyncedAt] = await Promise.all([getTape(), getRecentDepthSamples(now), getEarningsSyncedAt()]);
  const steady = new Map<string, SteadyDepth>(tape.rows.map((r) => [r.symbol, steadyDepth(samples, r.symbol, now, r.depthUsd)]));
  const costs = new Map<string, CostModel | null>();
  await Promise.all(
    briefShortlist(input, tape, steady, earningsSyncedAt, now).map(async (sym) => {
      const stock = getStock(sym);
      costs.set(sym, stock ? await withTimeout(getBuyQuoter(stock), QUOTE_TIMEOUT_MS).catch(() => null) : null);
    }),
  );
  const brief = buildBrief(input, tape, steady, costs, earningsSyncedAt, swapFee()?.bps ?? 0, now);
  const blocked = explain ? await whyNotExplain(request) : 'not-requested';
  const explained = blocked ? { text: null, why: blocked } : await explainBrief(brief, input.note);
  await countPlanBriefly({ explainedBy: explained.text != null ? 'claude' : 'fixed', buys: brief.picks?.length ?? 0, paid });
  return {
    brief,
    explanation: explained.text ?? fallbackBriefExplanation(brief),
    explainedBy: explained.text != null ? ('claude' as const) : ('fixed' as const),
    fixedBecause: explained.text != null ? null : explained.why,
  };
}

/** The saved-plan page (/plan/<id>): the same checks again, now, on the stocks the plan said to buy, with
 *  the same limits. A stock plan offers each stock that still passes, at most its saved amount; a basket
 *  is offered whole or not at all. Throws when the tape or a read fails (the page then offers no buy). */
export async function recheckSavedPlan(saved: SavedPlan): Promise<{
  legs: PlanLeg[];
  checkedAt: number;
  buys: RecheckedBuy[];
  basket: ReturnType<typeof basketRecheck> | null;
}> {
  const input = recheckInput(saved);
  const checkedAt = Date.now();
  if (!input) return { legs: [], checkedAt, buys: [], basket: null };
  const { legs } = await checkPlan(input, savedBuys(saved));
  if (saved.kind === 'plan') return { legs, checkedAt, buys: cappedBuys(saved, legs), basket: null };
  return { legs, checkedAt, buys: [], basket: basketRecheck(saved, legs) };
}
