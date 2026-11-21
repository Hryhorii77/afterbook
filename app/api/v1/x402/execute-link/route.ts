import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getStock } from '@/lib/stocks/tokens';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE } from '@/lib/server/x402';

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
    const quoter = await getBuyQuoter(stock);
    // The stock's page on Afterbook, at its swap (2026-11-21; Aerodrome's app until then): a person signs
    // there through the checked swap, with the Builder Code, behind the region gate and eligibility box.
    const swapUrl = `${request.nextUrl.origin}/${stock.symbol}#execute`;
    if (direction === 'sell') {
      // A sell is sized by its dollar value at the current Aero price
      // (usdcIn = "sell about this much"). Before 2026-10-12 this route
      // returned the buy estimate for both directions.
      const sell = quoter.sell(usdcIn);
      if (!sell) return NextResponse.json({ error: 'execute-link unavailable', detail: 'liquidity scan failed' }, { status: 502 });
      return NextResponse.json({
        symbol: stock.symbol,
        direction,
        usdcIn,
        sharesIn: sell.sharesIn,
        usdcOut: sell.usdcOut,
        execPriceUsd: sell.execPriceUsd,
        impactBp: sell.costBp,
        largeTradeCaveat: sell.exhaustedWindow,
        swapUrl,
      });
    }
    const estimate = quoter.estimate(usdcIn);
    return NextResponse.json({
      symbol: stock.symbol,
      direction,
      usdcIn,
      sharesOut: estimate.sharesOut,
      execPriceUsd: estimate.execPriceUsd,
      impactBp: estimate.impactBp,
      largeTradeCaveat: estimate.largeTradeCaveat,
      swapUrl,
    });
  } catch (err) {
    // The cause goes to the server log, not the response (it can name RPC hosts, contract errors).
    console.error('[/api/v1/x402/execute-link]', err);
    return NextResponse.json({ error: 'execute-link unavailable' }, { status: 502 });
  }
}

// Deliberately a link, not raw calldata: this route never returns calldata or touches a key. Until
// 2026-11-21 the link opened Aerodrome's own app (when it was written, no router this app could confirm
// worked on these Slipstream pools); a trade signed there skipped Afterbook's swap checks and carried no
// Builder Code. It now opens the stock's page on Afterbook, whose swap (KyberSwap, checked in
// lib/swap/swap.ts and again in the browser) is signed in the person's own wallet. For a checked plan
// with a link that opens already filled in, agents call /api/v1/x402/plan.
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
          'Sized trade estimate (buy or sell direction) for one of Afterbook\'s tracked stock pools plus swapUrl, the stock\'s page on afterbook.app where a person signs the trade in their own wallet through the checked swap. Not raw calldata.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
