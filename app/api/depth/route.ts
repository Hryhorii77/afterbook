import { NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { getCachedPoolState } from '@/lib/quote';
import { getCachedLiquidityDistribution } from '@/lib/depth';
import { computeFeeApr } from '@/lib/feeApr';

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
    const feeApr = await computeFeeApr(stock.symbol, stock, distribution.currentPriceUsd, state.multiplier).catch(() => null);
    return NextResponse.json({
      symbol: stock.symbol,
      ...distribution,
      feeAprPct: feeApr?.aprPct ?? null,
      feeAprWindowDays: feeApr?.windowDays ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: 'depth unavailable', detail: String(err) }, { status: 502 });
  }
}
