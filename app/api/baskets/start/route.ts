import { NextRequest, NextResponse } from 'next/server';
import { listPortfolios, startPortfolio } from '@/lib/baskets/glider';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';
import { startAgeProblem, startMessage, START_MAX_AGE_MS } from '@/lib/baskets/startAuth';
import { getClient } from '@/lib/market/quote';
import { getAddress, keccak256 } from 'viem';
import { redis } from '@/lib/server/redis';

export const revalidate = 0;

// Resumes scheduled rebalancing on the owner's portfolio. Glider itself needs no user signature for it, so the
// owner's own signature is checked here (lib/baskets/startAuth.ts, 2026-11-22): until then anyone could restart
// automation on someone else's portfolio by sending their address. The portfolio is still resolved from the
// owner address, never taken from the caller.
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const body = await readJson(request);
  const { owner, issuedAt, signature } = body ?? {};
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 20_000) {
    return NextResponse.json({ error: 'a signature from the owner is required' }, { status: 401 });
  }
  // Checksum the owner here: a mixed-case address with a wrong checksum is just refused below, never a 500.
  const wallet = getAddress(owner.toLowerCase());
  const stale = startAgeProblem(issuedAt);
  if (stale) return NextResponse.json({ error: stale }, { status: 401 });
  // EOA signatures, and smart wallets (ERC-1271, or ERC-6492 before the account is deployed), on Base.
  const valid = await getClient()
    .verifyMessage({ address: wallet, message: startMessage(wallet, issuedAt as number), signature: signature as `0x${string}` })
    .catch(() => false);
  if (!valid) return NextResponse.json({ error: 'the signature is not from this wallet' }, { status: 401 });
  // Single use: a captured request can't be sent again inside its 5 minutes. Without a store (or if it errors)
  // the time limit alone applies; a replay could only restart what this owner just asked to start.
  const used = redis
    ? await redis.set(`basketstart:${keccak256(signature as `0x${string}`)}`, 1, { nx: true, ex: Math.ceil(START_MAX_AGE_MS / 1000) + 60 }).catch(() => 'OK')
    : 'OK';
  if (used == null) return NextResponse.json({ error: 'this signature was already used; press Start again' }, { status: 401 });
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    if (!portfolios[0]) return NextResponse.json({ error: 'no portfolio for this address' }, { status: 404 });
    return NextResponse.json(await startPortfolio(portfolios[0].portfolioId));
  } catch (err) {
    return errorResponse(err);
  }
}
