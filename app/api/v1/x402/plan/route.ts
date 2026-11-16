// GET /api/v1/x402/plan: the trade plan (/plan) for agents, paid per call with x402 ($0.05 in USDC on Base).
// The same code as the page (lib/agent/runPlan.ts): every verdict and size comes from the checks, Claude
// only explains (or the fixed words do). Read-only: it builds nothing a wallet could sign; a person buys
// on afterbook.app behind the region gate and the eligibility box. A 400 or 502 isn't charged (withX402
// settles only a successful response). Counted as a paid plan for traction (lib/agent/planStats.ts).
import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { limitRead } from '@/lib/server/readGuard';
import { getStock } from '@/lib/stocks/tokens';
import { planFromQuery } from '@/lib/agent/x402Input';
import { runPlan } from '@/lib/agent/runPlan';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE_PREMIUM } from '@/lib/server/x402';

export const revalidate = 0;
export const maxDuration = 60;

async function handler(request: NextRequest) {
  // In-memory, per caller: the handler runs after the payment is verified but before it settles, so
  // one signed payment sent many times at once could run many plans (review); a 429 isn't charged.
  const limited = limitRead(request, 'agent-plan', 'lots');
  if (limited) return limited;
  const input = planFromQuery(request.nextUrl.searchParams, (s) => !!getStock(s));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  try {
    const out = await runPlan(input, request, true);
    return NextResponse.json({
      ...out,
      // Where a person reviews and signs a buy; this API never builds a transaction.
      buyAt: `${request.nextUrl.origin}/plan`,
    });
  } catch (err) {
    console.error('[/api/v1/x402/plan]', err);
    return NextResponse.json({ error: 'plan unavailable, try again shortly' }, { status: 502 });
  }
}

export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: { scheme: 'exact', price: X402_PRICE_PREMIUM, network: X402_NETWORK, payTo: X402_PAYOUT_ADDRESS! },
        description:
          'Checked trade plan for Coinbase tokenized stocks on Base: for each stock a buy, wait or skip verdict with reasons (gap to the real stock, stale pool, earnings, depth) and a size within your cost limit, $25k and 10% of the pool, plus a plain-English explanation. Read-only; a person signs any buy on afterbook.app.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
