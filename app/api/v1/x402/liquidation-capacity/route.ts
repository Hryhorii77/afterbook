import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getStock } from '@/lib/tokens';
import { getStockLiquidationRisk } from '@/lib/liquidationRisk';
import { positionRisk } from '@/lib/liquidationMath';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE_PREMIUM } from '@/lib/x402';

export const revalidate = 0;

async function handler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const stock = getStock(searchParams.get('symbol') ?? '');
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  // Optional position: both or neither.
  const sharesRaw = searchParams.get('collateralShares');
  const borrowRaw = searchParams.get('borrowUsd');
  const collateralShares = sharesRaw == null ? null : Number(sharesRaw);
  const borrowUsd = borrowRaw == null ? null : Number(borrowRaw);
  if ((collateralShares == null) !== (borrowUsd == null)) {
    return NextResponse.json({ error: 'pass both collateralShares and borrowUsd, or neither' }, { status: 400 });
  }
  if (collateralShares != null && !(collateralShares > 0 && borrowUsd! > 0)) {
    return NextResponse.json({ error: 'collateralShares and borrowUsd must be positive numbers' }, { status: 400 });
  }

  try {
    const risk = await getStockLiquidationRisk(stock.symbol);
    if (!risk) return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });

    const marketId = searchParams.get('marketId')?.toLowerCase();
    // Default market for a position: the one holding the most collateral.
    const market = marketId
      ? risk.markets.find((m) => m.marketId.toLowerCase() === marketId)
      : [...risk.markets].sort((a, b) => b.collateralUsd - a.collateralUsd)[0];
    if (marketId && !market) {
      return NextResponse.json({ error: 'no Morpho or Aave USDC market with that id for this symbol' }, { status: 400 });
    }

    const position =
      collateralShares != null && market
        ? {
            marketId: market.marketId,
            collateralShares,
            borrowUsd,
            ...positionRisk({
              collateralShares,
              borrowUsd: borrowUsd!,
              lltv: market.lltv,
              lif: market.liquidationIncentiveFactor,
              oraclePriceUsd: market.oraclePriceUsd,
              aeroGap: market.aeroVsOracleBp / 10_000,
              curve: risk.sellCurve,
            }),
          }
        : null;

    return NextResponse.json({
      symbol: risk.symbol,
      aeroMidUsd: risk.aeroMidUsd,
      // Selling `usd` of the stock on Aero right now fills on average
      // `discountBp` below mid, pool fee included; exhaustedWindow means the
      // sell ran past the liquidity Afterbook scans (25% below mid).
      sellCurve: risk.sellCurve,
      markets: risk.markets,
      position,
      assumptions:
        'Snapshot of the Aero pool now. Position risk assumes the same liquidity per tick and the same Aero-vs-oracle gap at the liquidation price. Liquidators with another exit than Aero may do better. Aave markets (venue "aave", marketId "aave:<reserveId>") lend one shared USDC pool against every stock, so their borrowUsd is null; Aave liquidates only enough to restore health, so seizedUsd is an upper bound there.',
    });
  } catch (err) {
    // The cause goes to the server log, not the response (it can name RPC hosts, contract errors).
    console.error('[/api/v1/x402/liquidation-capacity]', err);
    return NextResponse.json({ error: 'liquidation-capacity unavailable' }, { status: 502 });
  }
}

// For lenders, liquidation bots and agents: can Aero absorb a
// liquidation of this stock at a profit, how far is the pool from the
// lending oracle, and (optionally) where would a given position be
// liquidated and could that sale be absorbed.
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
        description:
          "Liquidation capacity for a Base tokenized stock: Morpho and Aave V4 USDC markets using it as collateral, the Aero-vs-oracle gap, the largest liquidation Aero can absorb at a profit, a sell-side impact curve, and optional per-position liquidation price and risk.",
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });
