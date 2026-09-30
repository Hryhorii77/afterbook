import { NextRequest, NextResponse } from 'next/server';
import { listPortfolios, withdrawSignature } from '@/lib/glider';
import { BASE_CHAIN_ID } from '@/lib/baskets/tilt';
import { guardBasketRequest, readJson, errorResponse, OWNER_RE, BASE_ASSET_RE, RAW_AMOUNT_RE, ownerAccountId, strategyId } from '@/lib/baskets/guard';

export const revalidate = 0;

// Stage 1: the owner's wallet will sign this, bound to recipient, assets and
// amounts, and it expires in 10 minutes. The portfolio is resolved from the
// owner address server-side, so a caller can't ask for someone else's.
// Recipient defaults to the owner; amountRaw values come from /positions.
export async function POST(request: NextRequest) {
  const blocked = await guardBasketRequest(request);
  if (blocked) return blocked;
  const b = await readJson(request);
  const { owner, recipient, assets, liquidate } = b ?? {};
  if (liquidate !== undefined && typeof liquidate !== 'boolean') return NextResponse.json({ error: 'liquidate must be a boolean' }, { status: 400 });
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return NextResponse.json({ error: 'owner must be a 0x address' }, { status: 400 });
  const to = recipient ?? owner;
  if (typeof to !== 'string' || !OWNER_RE.test(to)) return NextResponse.json({ error: 'recipient must be a 0x address' }, { status: 400 });
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 50) return NextResponse.json({ error: 'assets must be a non-empty array' }, { status: 400 });
  const clean: { assetId: string; amountRaw: string }[] = [];
  for (const a of assets) {
    if (!a || typeof a.assetId !== 'string' || !BASE_ASSET_RE.test(a.assetId) || typeof a.amountRaw !== 'string' || !RAW_AMOUNT_RE.test(a.amountRaw)) {
      return NextResponse.json({ error: 'each asset needs a Base ERC-20 assetId and an integer-string amountRaw' }, { status: 400 });
    }
    clean.push({ assetId: a.assetId, amountRaw: a.amountRaw });
  }
  try {
    const { portfolios } = await listPortfolios({ ownerAccountId: ownerAccountId(owner), strategyId: strategyId()! });
    const portfolio = portfolios[0];
    if (!portfolio) return NextResponse.json({ error: 'no portfolio for this address' }, { status: 404 });
    const sig = await withdrawSignature(portfolio.portfolioId, { recipientAccountId: `eip155:${BASE_CHAIN_ID}:${to}`, assets: clean, ...(liquidate ? { liquidate: true } : {}) });
    return NextResponse.json({ portfolioId: portfolio.portfolioId, ...sig });
  } catch (err) {
    return errorResponse(err);
  }
}
