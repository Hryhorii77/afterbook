import { NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { getCachedPoolState, poolDepth, getClient, ERC20_ABI, MULTIPLIER_ONE } from '@/lib/quote';
import { getCachedLiquidityDistribution } from '@/lib/depth';
import { computeFeeAprWithFallback } from '@/lib/feeApr';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  try {
    const state = await getCachedPoolState(stock);
    const distribution = await getCachedLiquidityDistribution(stock, state);
    // Pool-wide, not range-adjusted — same figure MyLots shows for existing
    // positions. The range selector's own capitalEfficiencyMultiplier
    // (lib/lpRange.ts) is what turns this into a range-specific estimate,
    // computed client-side so it can update live while dragging.
    const tvlUsd = poolDepth(state, stock).totalUsd;
    const [feeApr, totalSupplyRaw] = await Promise.all([
      computeFeeAprWithFallback(stock.symbol, stock, distribution.currentPriceUsd, state.multiplier, tvlUsd).catch(() => null),
      // Live totalSupply() on the B20 token itself — the one piece of the
      // "is this token legit" question that's actually verifiable on-chain
      // from this app. The custodian/1:1-backing claim (Alpaca, per
      // Coinbase's own docs) is NOT something a Base RPC can confirm — the
      // UI cites it as the issuer's stated claim, not something this app
      // verified, on purpose.
      getClient()
        .readContract({ address: stock.tokenAddress as `0x${string}`, abi: ERC20_ABI, functionName: 'totalSupply' })
        .catch(() => null),
    ]);
    const totalSupplyShares =
      totalSupplyRaw != null ? (Number(totalSupplyRaw) / 10 ** stock.decimals) * (Number(state.multiplier) / MULTIPLIER_ONE) : null;

    return NextResponse.json({
      symbol: stock.symbol,
      ...distribution,
      feeAprPct: feeApr?.aprPct ?? null,
      feeAprWindowDays: feeApr?.windowDays ?? null,
      feeAprEstimated: feeApr?.estimated ?? false,
      totalSupplyShares,
    });
  } catch (err) {
    return NextResponse.json({ error: 'depth unavailable', detail: String(err) }, { status: 502 });
  }
}
