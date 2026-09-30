import { NextRequest, NextResponse } from 'next/server';
import { enroll } from '@/lib/glider';
import { BASE_CHAIN_ID } from '@/lib/baskets/tilt';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

// Stage 2: forwards the stage-1 round-trip fields byte-for-byte plus the
// user's signature. Nothing here is modified — Glider requires it unchanged.
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const b = await readJson(request);
  const { owner, accountIndex, agentAccountId, signature, flowId, portfolioName } = b ?? {};
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  if (typeof accountIndex !== 'string' || typeof agentAccountId !== 'string' || typeof flowId !== 'string') {
    return NextResponse.json({ error: 'accountIndex, agentAccountId and flowId are required strings' }, { status: 400 });
  }
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) return NextResponse.json({ error: 'signature must be 0x hex' }, { status: 400 });
  if (portfolioName !== undefined && (typeof portfolioName !== 'string' || portfolioName.length > 80)) {
    return NextResponse.json({ error: 'portfolioName must be a string up to 80 chars' }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await enroll({
        ownerAccountId: ownerAccountId(owner),
        strategyId: strategyId()!,
        chainIds: [BASE_CHAIN_ID],
        accountIndex,
        agentAccountId,
        signature,
        flowId,
        ...(portfolioName ? { portfolioName } : {}),
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
