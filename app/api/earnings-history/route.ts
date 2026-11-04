import { NextResponse } from 'next/server';
import { getStock } from '@/lib/stocks/tokens';
import { getEarningsMoveStats } from '@/lib/stocks/earningsHistory';
import { limitRead } from '@/lib/server/readGuard';

export const revalidate = 0;

export async function GET(request: Request) {
  const limited = limitRead(request, 'earnings-history');
  if (limited) return limited;
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  const stats = await getEarningsMoveStats(stock.symbol);
  return NextResponse.json({ symbol: stock.symbol, stats });
}
