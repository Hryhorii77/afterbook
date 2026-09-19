import { NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { getEarningsMoveStats } from '@/lib/earningsHistory';

export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  const stats = await getEarningsMoveStats(stock.symbol);
  return NextResponse.json({ symbol: stock.symbol, stats });
}
