import { NextRequest, NextResponse } from 'next/server';
import { listPortfolios, startPortfolio } from '@/lib/glider';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

// Resumes scheduled rebalancing on the owner's portfolio. Needs no user
// signature (Glider's own docs: start after funds show up in positions), so
// the only thing guarding it is that the portfolio is resolved from the
// owner address rather than taken from the caller.
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const owner = (await readJson(request))?.owner;
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    if (!portfolios[0]) return NextResponse.json({ error: 'no portfolio for this address' }, { status: 404 });
    return NextResponse.json(await startPortfolio(portfolios[0].portfolioId));
  } catch (err) {
    return errorResponse(err);
  }
}
