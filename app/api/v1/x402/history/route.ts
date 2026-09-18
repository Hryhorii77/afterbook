import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getStock } from '@/lib/tokens';
import { getHistory } from '@/lib/history';
import { getCachedPoolState } from '@/lib/quote';
import { getLiquidityDistribution } from '@/lib/depth';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE_PREMIUM } from '@/lib/x402';

export const revalidate = 0;

const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

async function handler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  const sinceParam = searchParams.get('since');
  const requestedSince = sinceParam && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : Date.now() - MAX_LOOKBACK_MS;
  // lib/history.ts only retains 30 days server-side anyway — clamp here too
  // so the response's `since` field never claims a wider window than the
  // data actually covers.
  const sinceMs = Math.max(requestedSince, Date.now() - MAX_LOOKBACK_MS);

  try {
    const [samples, state] = await Promise.all([getHistory(stock.symbol, sinceMs), getCachedPoolState(stock)]);
    const distribution = await getLiquidityDistribution(stock, state);
    return NextResponse.json({
      symbol: stock.symbol,
      since: sinceMs,
      basisHistory: samples,
      tickDistribution: distribution,
    });
  } catch (err) {
    return NextResponse.json({ error: 'history unavailable', detail: String(err) }, { status: 502 });
  }
}

// Backtesting-oriented tier: the same 30-day basis samples the free basis
// chart draws from (lib/history.ts), plus the live tick-liquidity
// distribution lib/depth.ts computes for the depth chart — bundled since a
// backtest wants both the historical mispricing signal and how thick the
// book was to trade against it.
export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: {
          scheme: 'exact',
          price: X402_PRICE_PREMIUM,
          network: X402_NETWORK,
          payTo: X402_PAYOUT_ADDRESS!,
        },
        description: '30-day basis-history samples plus the current on-chain tick liquidity distribution for one of Afterbook\'s ten stock pools.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
