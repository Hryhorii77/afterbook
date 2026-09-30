import { NextRequest, NextResponse } from 'next/server';
import { enrollSignature } from '@/lib/glider';
import { BASE_CHAIN_ID } from '@/lib/baskets/tilt';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

// Stage 1: returns the exact message the user's wallet will sign. The
// strategy and chain are fixed server-side — the browser only says who is
// enrolling.
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const body = await readJson(request);
  const owner = body?.owner;
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) {
    return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await enrollSignature({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()!, chainIds: [BASE_CHAIN_ID], accountType: 'ECDSA' }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
