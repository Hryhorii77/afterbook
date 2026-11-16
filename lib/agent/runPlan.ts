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
import { screen, sizeLegs, summarize, fallbackExplanation, type CostModel, type PlanInput } from './plan';
import { briefShortlist, buildBrief, fallbackBriefExplanation, type BriefInput } from './brief';
import { explainPlan, explainBrief } from './explain';
import { whyNotExplain } from './explainGate';
import { countPlanBriefly } from './planStats';

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

/** `paid`: an x402 call (counted apart, for traction). Throws when the tape or a read fails. */
export async function runPlan(input: PlanInput, request: Request, paid = false) {
  const tape = await getTape();
  const legs = screen(input, tape, await getEarningsSyncedAt());
  const costs = new Map<string, CostModel | null>();
  await Promise.all(
    legs
      .filter((l) => l.verdict === 'buy')
      .map(async (l) => {
        const stock = getStock(l.symbol);
        costs.set(l.symbol, stock ? await getBuyQuoter(stock).catch(() => null) : null);
      }),
  );
  const plan = summarize(sizeLegs(legs, input, costs, swapFee()?.bps ?? 0), input, tape.session);
  const blocked = await whyNotExplain(request);
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

export async function runBrief(input: BriefInput, request: Request, paid = false) {
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
  const blocked = await whyNotExplain(request);
  const explained = blocked ? { text: null, why: blocked } : await explainBrief(brief, input.note);
  await countPlanBriefly({ explainedBy: explained.text != null ? 'claude' : 'fixed', buys: brief.picks?.length ?? 0, paid });
  return {
    brief,
    explanation: explained.text ?? fallbackBriefExplanation(brief),
    explainedBy: explained.text != null ? ('claude' as const) : ('fixed' as const),
    fixedBecause: explained.text != null ? null : explained.why,
  };
}
