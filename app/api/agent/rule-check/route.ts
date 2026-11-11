// POST /api/agent/rule-check: is one due run of a personal stock rule (/rules, lib/agent/rules.ts) inside
// its limits right now, and how much would it buy? The trade plan's own code decides (lib/agent/plan.ts
// screen + sizeLegs) for a single stock with the run's amount as the budget. No Claude call: the reasons
// are the plan's fixed sentences. Read-only: it builds nothing a wallet could sign; a run that passes is
// reviewed and signed in the swap panel. The rule itself never reaches the server, only these inputs.
import { NextResponse } from 'next/server';
import { getTape } from '@/lib/market/tape';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { getStock } from '@/lib/stocks/tokens';
import { swapFee } from '@/lib/swap/swap';
import { getEarningsSyncedAt } from '@/lib/stocks/earningsCalendar';
import { limitRead } from '@/lib/server/readGuard';
import { parsePlanInput, screen, sizeLegs, type CostModel } from '@/lib/agent/plan';
import { RULE_LIMITS } from '@/lib/agent/rules';
import { countRuleCheckBriefly } from '@/lib/agent/planStats';

export const maxDuration = 30;

export async function POST(request: Request) {
  // The 10-a-minute bucket: a check is a deliberate click, not a poll.
  const limited = limitRead(request, 'agent-rule', 'lots');
  if (limited) return limited;
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // answered below
  }
  if (!body) return NextResponse.json({ error: 'expected a JSON object' }, { status: 400 });
  if (typeof body.symbol !== 'string') return NextResponse.json({ error: 'the stock is missing' }, { status: 400 });
  const usd = typeof body.usd === 'number' ? body.usd : NaN;
  if (!Number.isFinite(usd) || usd < RULE_LIMITS.minRunUsd || usd > RULE_LIMITS.maxRunUsd) {
    return NextResponse.json({ error: `a run must be between $${RULE_LIMITS.minRunUsd} and $${RULE_LIMITS.maxRunUsd.toLocaleString('en-US')}` }, { status: 400 });
  }
  const input = parsePlanInput(
    { symbols: [body.symbol], budgetUsd: usd, maxPremiumBp: body.maxPremiumBp, maxCostBp: body.maxCostBp, earningsDays: body.earningsDays, note: '' },
    (s) => !!getStock(s),
  );
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });

  try {
    const tape = await getTape();
    const legs = screen(input, tape, await getEarningsSyncedAt());
    const leg = legs[0];
    if (!leg) return NextResponse.json({ error: 'that stock isn’t on the tape right now' }, { status: 404 });
    const costs = new Map<string, CostModel | null>();
    if (leg.verdict === 'buy') {
      const stock = getStock(leg.symbol);
      costs.set(leg.symbol, stock ? await getBuyQuoter(stock).catch(() => null) : null);
    }
    sizeLegs(legs, input, costs, swapFee()?.bps ?? 0);
    await countRuleCheckBriefly(leg.verdict === 'buy');
    return NextResponse.json({
      leg,
      session: { state: tape.session.state, label: tape.session.label, nextOpenIso: tape.session.nextOpenIso },
      checkedAt: Date.now(),
    });
  } catch (err) {
    console.error('[/api/agent/rule-check]', err);
    return NextResponse.json({ error: 'check unavailable, try again shortly' }, { status: 502 });
  }
}
