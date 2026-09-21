import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getStock, aerodromeSwapUrl } from '@/lib/tokens';
import { estimateLot, getCachedPoolState } from '@/lib/quote';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE } from '@/lib/x402';

export const revalidate = 0;

async function handler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';
  const usdcInRaw = searchParams.get('usdcIn') ?? '';
  const directionRaw = searchParams.get('direction') ?? 'buy';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  if (directionRaw !== 'buy' && directionRaw !== 'sell') {
    return NextResponse.json({ error: 'direction must be "buy" or "sell"' }, { status: 400 });
  }
  const direction = directionRaw;

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
    return NextResponse.json({
      symbol: stock.symbol,
      direction,
      usdcIn,
      sharesOut: estimate.sharesOut,
      execPriceUsd: estimate.execPriceUsd,
      impactBp: estimate.impactBp,
      largeTradeCaveat: estimate.largeTradeCaveat,
      swapUrl: aerodromeSwapUrl(stock, direction),
    });
  } catch (err) {
    return NextResponse.json({ error: 'execute-link unavailable', detail: String(err) }, { status: 502 });
  }
}

// Deliberately a link, not raw calldata: this app has no confirmed-working
// router for these Slipstream pools outside Aerodrome's own frontend —
// their documented public SwapRouter/Quoter are bound to a different CL
// factory and revert on these specific pools (verified on-chain,
// pool.factory() != quoter.factory()), and every alternative checked
// (Aerodrome's Universal Router — zero real transactions against these
// pools in a live sample; their classic Router.sol — built for the old
// stable/volatile AMM pools, architecturally incompatible with Slipstream)
// came up empty or wrong. Returning calldata this app can't confirm
// actually executes would risk an agent burning real gas on a revert — the
// same verified deep link the human UI already uses is the responsible
// thing to hand back instead. An agent's own execution layer opens/submits
// it; this app still never constructs calldata or touches a key.
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
        description:
          'Sized trade estimate plus a verified Aerodrome deep link (buy or sell direction) for one of Afterbook\'s ten stock pools — not raw calldata, see route source for why.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
