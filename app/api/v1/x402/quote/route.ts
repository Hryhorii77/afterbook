import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getStock } from '@/lib/tokens';
import { buildImpactCurve, estimateLot, getCachedPoolState } from '@/lib/quote';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE } from '@/lib/x402';

export const revalidate = 0;

async function handler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';
  const usdcInRaw = searchParams.get('usdcIn') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  const usdcIn = Number(usdcInRaw);
  if (!Number.isFinite(usdcIn) || usdcIn <= 0) {
    return NextResponse.json({ error: 'usdcIn must be a positive number' }, { status: 400 });
  }
  if (usdcIn > 10_000_000) {
    return NextResponse.json({ error: 'usdcIn too large' }, { status: 400 });
  }

  try {
    const state = await getCachedPoolState(stock);
    const estimate = estimateLot(state, stock, usdcIn);
    const curve = buildImpactCurve(state, stock);
    return NextResponse.json({ symbol: stock.symbol, ...estimate, curve });
  } catch (err) {
    return NextResponse.json({ error: 'quote unavailable', detail: String(err) }, { status: 502 });
  }
}

// Same estimateLot/buildImpactCurve path /api/quote and the MCP get_quote
// tool already share (and the same 20s pool-state cache) — a third,
// machine-payable caller of an already-shared, already-cached path.
export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: {
          scheme: 'exact',
          price: X402_PRICE,
          network: X402_NETWORK,
          payTo: X402_PAYOUT_ADDRESS!,
        },
        description: 'Sized USDC-to-share quote (execution price, impact, impact curve) for one of Afterbook\'s ten stock pools.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
