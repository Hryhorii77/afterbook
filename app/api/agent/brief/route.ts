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
import { mayExplain } from '@/lib/agent/explainGate';
import { countPlanBriefly } from '@/lib/agent/planStats';

export const maxDuration = 60;

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
        costs.set(sym, stock ? await getBuyQuoter(stock).catch(() => null) : null);
      }),
    );
    const brief = buildBrief(input, tape, steady, costs, earningsSyncedAt, swapFee()?.bps ?? 0, now);
    const explained = (await mayExplain(request)) ? await explainBrief(brief, input.note) : null;
    await countPlanBriefly({ explainedBy: explained ? 'claude' : 'fixed', buys: brief.picks?.length ?? 0 });
    return NextResponse.json({
      brief,
      explanation: explained ?? fallbackBriefExplanation(brief),
      explainedBy: explained ? 'claude' : 'fixed',
    });
  } catch (err) {
    console.error('[/api/agent/brief]', err);
    return NextResponse.json({ error: 'basket unavailable, try again shortly' }, { status: 502 });
  }
}
