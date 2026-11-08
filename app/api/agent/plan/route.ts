// POST /api/agent/plan: the trade plan (lib/agent/plan.ts) plus Claude's explanation (lib/agent/explain.ts).
// Read-only: it builds nothing a wallet could sign. A buy is reviewed and signed in the swap panel.
import { NextResponse } from 'next/server';
import { getTape } from '@/lib/market/tape';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { getStock } from '@/lib/stocks/tokens';
import { swapFee } from '@/lib/swap/swap';
import { getEarningsSyncedAt } from '@/lib/stocks/earningsCalendar';
import { limitRead } from '@/lib/server/readGuard';
import { agentLimiter, agentDailyLimiter } from '@/lib/server/ratelimit';
import { parsePlanInput, screen, sizeLegs, summarize, fallbackExplanation, type CostModel } from '@/lib/agent/plan';
import { explainPlan, explainerConfigured } from '@/lib/agent/explain';
import { countPlanBriefly } from '@/lib/agent/planStats';

export const maxDuration = 60;

function callerIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** May this request spend a Claude call? Without Redis there is no cap that holds across instances, so no:
 *  the plan is then explained in fixed words. */
async function mayExplain(request: Request): Promise<boolean> {
  if (!explainerConfigured()) return false;
  if (!agentLimiter || !agentDailyLimiter) return false;
  const mine = await agentLimiter.limit(callerIp(request));
  if (!mine.success) return false;
  return (await agentDailyLimiter.limit('all')).success;
}

export async function POST(request: Request) {
  // The 10-a-minute bucket: a plan is a deliberate click, not a poll.
  const limited = limitRead(request, 'agent-plan', 'lots');
  if (limited) return limited;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const input = parsePlanInput(body, (s) => !!getStock(s));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });

  try {
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
    const explained = (await mayExplain(request)) ? await explainPlan(plan, input) : null;
    await countPlanBriefly({ explainedBy: explained ? 'claude' : 'fixed', buys: plan.legs.filter((l) => l.verdict === 'buy').length });
    return NextResponse.json({
      plan,
      explanation: explained ?? fallbackExplanation(plan),
      explainedBy: explained ? 'claude' : 'fixed',
    });
  } catch (err) {
    console.error('[/api/agent/plan]', err);
    return NextResponse.json({ error: 'plan unavailable, try again shortly' }, { status: 502 });
  }
}
