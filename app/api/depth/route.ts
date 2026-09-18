import { NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { getCachedPoolState } from '@/lib/quote';
import { getCachedLiquidityDistribution } from '@/lib/depth';

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
    return NextResponse.json({ symbol: stock.symbol, ...distribution });
  } catch (err) {
    return NextResponse.json({ error: 'depth unavailable', detail: String(err) }, { status: 502 });
  }
}
