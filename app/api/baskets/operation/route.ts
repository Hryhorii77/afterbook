import { NextRequest, NextResponse } from 'next/server';
import { listPortfolios, getOperation } from '@/lib/glider';
import { guardBasketRequest, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

const OPERATION_RE = /^[A-Za-z0-9_-]{1,80}$/;

// Poll target for an async withdrawal. The portfolio is resolved from the
// owner address, so an operation id is only ever looked up inside that
// owner's own portfolio.
export async function GET(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const owner = request.nextUrl.searchParams.get('owner');
  const operationId = request.nextUrl.searchParams.get('operationId');
  if (!owner || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  if (!operationId || !OPERATION_RE.test(operationId)) return NextResponse.json({ error: 'invalid operationId' }, { status: 400 });
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    if (!portfolios[0]) return NextResponse.json({ error: 'no portfolio for this address' }, { status: 404 });
    return NextResponse.json(await getOperation(portfolios[0].portfolioId, operationId));
  } catch (err) {
    return errorResponse(err);
  }
}
