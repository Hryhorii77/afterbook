// GET /api/v1/x402/basket: "Describe a basket" (/plan's second tab) for agents, paid per call with x402
// ($0.05 in USDC on Base). The code picks the stocks from fixed themes and sectors, deepest steady pool
// first, and sizes them (lib/agent/runPlan.ts, the same as the page); Claude only explains. Read-only:
// the basket is saved and `buyUrl` (afterbook.app/plan/<id>) opens it for a person, who signs the buy
// there after the checks run again (lib/agent/planLink.ts); `buildUrl` is its /build page. A 400 or 502
// isn't charged. Counted as a paid plan for traction.
import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { limitRead } from '@/lib/server/readGuard';
import { basketFromQuery } from '@/lib/agent/x402Input';
import { runBrief } from '@/lib/agent/runPlan';
import { buildPath } from '@/lib/build/customBasket';
import { saveBasket } from '@/lib/agent/savedPlan';
import { planLinkPath } from '@/lib/agent/planLink';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE_PREMIUM } from '@/lib/server/x402';

export const revalidate = 0;
export const maxDuration = 60;

async function handler(request: NextRequest) {
  // In-memory, per caller: the handler runs after the payment is verified but before it settles, so
  // one signed payment sent many times at once could run many plans (review); a 429 isn't charged.
  const limited = limitRead(request, 'agent-plan', 'lots');
  if (limited) return limited;
  const input = basketFromQuery(request.nextUrl.searchParams);
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });
  try {
    const out = await runBrief(input, request, { paid: true });
    const basket = out.brief.basket;
    const id = await saveBasket(out, 'x402');
    const buildUrl = basket ? `${request.nextUrl.origin}${buildPath(basket)}` : null;
    return NextResponse.json({
      ...out,
      // Where a person opens this basket and signs its buy, capped at its amount (null when there is no
      // basket; the /build page if it couldn't be saved).
      buyUrl: id ? `${request.nextUrl.origin}${planLinkPath(id)}` : buildUrl,
      buildUrl,
    });
  } catch (err) {
    console.error('[/api/v1/x402/basket]', err);
    return NextResponse.json({ error: 'basket unavailable, try again shortly' }, { status: 502 });
  }
}

export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: { scheme: 'exact', price: X402_PRICE_PREMIUM, network: X402_NETWORK, payTo: X402_PAYOUT_ADDRESS! },
        description:
          'A 2-4 stock basket of Coinbase tokenized stocks on Base from a theme or sectors: the code picks the deepest steady pools that pass the checks and sizes them within your budget and cost limit, with every dropped stock and why, a plain-English explanation and buyUrl, a link where a person opens this basket and signs its buy on afterbook.app after the checks run again. Read-only.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
