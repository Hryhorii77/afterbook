import { NextRequest, NextResponse } from 'next/server';
import { listPortfolios, getPositions } from '@/lib/glider';
import { guardBasketRequest, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

// The owner's Basis Tilt portfolio (if any) with live positions. Portfolios
// are looked up by owner address and only that owner's are ever returned —
// the tenant key can see everyone's, so this never takes a portfolioId from
// the caller.
export async function GET(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const owner = request.nextUrl.searchParams.get('owner');
  if (!owner || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    const portfolio = portfolios[0] ?? null;
    return NextResponse.json({ portfolio, positions: portfolio ? await getPositions(portfolio.portfolioId) : null });
  } catch (err) {
    return errorResponse(err);
  }
}
