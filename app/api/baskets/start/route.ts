import { NextRequest, NextResponse } from 'next/server';
import { getAddress } from 'viem';
import { listPortfolios, startPortfolio } from '@/lib/baskets/glider';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';
import { ownerActionRefusal } from '@/lib/baskets/ownerAuth';
import { depositAccountProblem, deployedAccountProblem } from '@/lib/baskets/depositAccount';
import { getClient } from '@/lib/market/quote';

export const revalidate = 0;

const BASE_PREFIX = 'eip155:8453:';

// Resumes scheduled rebalancing on the owner's portfolio. Glider itself needs no user signature for it, so the
// owner's own signature is checked here (lib/baskets/startAuth.ts, 2026-11-22): until then anyone could restart
// automation on someone else's portfolio by sending their address. The portfolio is still resolved from the
// owner address, never taken from the caller, and its account must pass the same checks the panel makes
// (the address maths, and on chain the implementation, root validator and signer): a tampered account is
// never started, whatever the browser says (review of #214).
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const body = await readJson(request);
  const { owner, issuedAt, signature } = body ?? {};
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  const refused = await ownerActionRefusal('start', owner, issuedAt, signature);
  if (refused) return refused;
  const wallet = getAddress(owner.toLowerCase());
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    const portfolio = portfolios[0];
    if (!portfolio) return NextResponse.json({ error: 'no portfolio for this address' }, { status: 404 });
    const deposit = portfolio.smartAccounts.find((a) => typeof a.accountId === 'string' && a.accountId.startsWith(BASE_PREFIX));
    const problem =
      depositAccountProblem(wallet, deposit) ?? (await deployedAccountProblem(getClient(), wallet, getAddress(deposit!.accountId.slice(BASE_PREFIX.length))));
    if (problem) return NextResponse.json({ error: `Refused: ${problem} Automation stays off.` }, { status: 409 });
    return NextResponse.json(await startPortfolio(portfolio.portfolioId));
  } catch (err) {
    return errorResponse(err);
  }
}
