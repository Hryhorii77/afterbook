// POST /api/agent/brief: "Describe a basket" on the trade plan (lib/agent/brief.ts) plus Claude's
// explanation (lib/agent/explain.ts). Read-only: it builds nothing a wallet could sign. The basket is
// reviewed and signed in /build's normal basket buy.
import { NextResponse } from 'next/server';
import { getTape } from '@/lib/market/tape';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { getRecentDepthSamples, steadyDepth, type SteadyDepth } from '@/lib/market/depthSamples';
import { getStock } from '@/lib/stocks/tokens';
import { swapFee } from '@/lib/swap/swap';
import { getEarningsSyncedAt } from '@/lib/stocks/earningsCalendar';
import { limitRead } from '@/lib/server/readGuard';
import { parseBriefInput, briefShortlist, buildBrief, fallbackBriefExplanation } from '@/lib/agent/brief';
import type { CostModel } from '@/lib/agent/plan';
import { explainBrief } from '@/lib/agent/explain';
import { whyNotExplain } from '@/lib/agent/explainGate';
import { countPlanBriefly } from '@/lib/agent/planStats';

export const maxDuration = 60;

// Each of the (up to 8) pool reads gets this long; one the RPC is slow on counts as unreadable (the
// brief then says so, or the next deepest stock takes its place), so a slow RPC can't hold the page
// until Vercel cuts it off (review of PR #175).
const QUOTE_TIMEOUT_MS = 8_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function POST(request: Request) {
  // The same 10-a-minute bucket as the plan: a brief is a deliberate click, not a poll.
  const limited = limitRead(request, 'agent-plan', 'lots');
  if (limited) return limited;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const input = parseBriefInput(body);
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });

  try {
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
    await countPlanBriefly({ explainedBy: explained.text != null ? 'claude' : 'fixed', buys: brief.picks?.length ?? 0 });
    return NextResponse.json({
      brief,
      explanation: explained.text ?? fallbackBriefExplanation(brief),
      explainedBy: explained.text != null ? 'claude' : 'fixed',
      // Why the fixed words were used (a hit limit vs. a reply the checks refused), null when Claude explained it.
      fixedBecause: explained.text != null ? null : explained.why,
    });
  } catch (err) {
    console.error('[/api/agent/brief]', err);
    return NextResponse.json({ error: 'basket unavailable, try again shortly' }, { status: 502 });
  }
}
