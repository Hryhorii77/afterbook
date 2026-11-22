import { NextRequest, NextResponse } from 'next/server';
import { getAddress } from 'viem';
import { listPortfolios, startPortfolio } from '@/lib/baskets/glider';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';
import { consumeOwnerAction, ownerActionSignatureRefusal } from '@/lib/baskets/ownerAuth';
import { depositAccountProblem, deployedAccountStatus } from '@/lib/baskets/depositAccount';
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
  const refused = await ownerActionSignatureRefusal('start', owner, issuedAt, signature);
  if (refused) return refused;
  const wallet = getAddress(owner.toLowerCase());
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    const portfolio = portfolios[0];
    if (!portfolio) return NextResponse.json({ error: 'no portfolio for this address' }, { status: 404 });
    const deposit = portfolio.smartAccounts.find((a) => typeof a.accountId === 'string' && a.accountId.startsWith(BASE_PREFIX));
    const maths = depositAccountProblem(wallet, deposit);
    if (maths) return NextResponse.json({ error: `Refused: ${maths} Automation stays off.` }, { status: 409 });
    const onChain = await deployedAccountStatus(getClient(), wallet, getAddress(deposit!.accountId.slice(BASE_PREFIX.length)));
    if (onChain.state === 'mismatch') return NextResponse.json({ error: `Refused: ${onChain.problem} Automation stays off.` }, { status: 409 });
    // A failed read is not a verdict: try again, with the same signature while it is fresh (it isn't used yet).
    if (onChain.state === 'unread') return NextResponse.json({ error: 'Couldn\u2019t read your Basis Tilt account on Base just now. Try again in a moment.' }, { status: 503 });
    const used = await consumeOwnerAction('start', wallet, issuedAt as number);
    if (used) return used;
    return NextResponse.json(await startPortfolio(portfolio.portfolioId));
  } catch (err) {
    return errorResponse(err);
  }
}
