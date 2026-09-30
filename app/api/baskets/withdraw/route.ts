import { NextRequest, NextResponse } from 'next/server';
import { listPortfolios, withdraw } from '@/lib/glider';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

// Stage 2: submits the user-signed authorization. `message` is the stage-1
// typedData.message passed through untouched. The portfolio id is re-derived
// from the owner, and the message must name that same portfolio.
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const b = await readJson(request);
  const { owner, message, signature } = b ?? {};
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  if (!message || typeof message !== 'object') return NextResponse.json({ error: 'message is required' }, { status: 400 });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return NextResponse.json({ error: 'signature must be 0x hex' }, { status: 400 });
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    const portfolio = portfolios[0];
    if (!portfolio || (message as { portfolioId?: unknown }).portfolioId !== portfolio.portfolioId) {
      return NextResponse.json({ error: 'message does not match this address\'s portfolio' }, { status: 400 });
    }
    return NextResponse.json(await withdraw(portfolio.portfolioId, { message, signature }), { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
