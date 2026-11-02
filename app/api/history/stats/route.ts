import { NextRequest, NextResponse } from 'next/server';
import { getClosedPeriodStats, getOpenSnapStats, STATS_LOOKBACK_MS } from '@/lib/history';
import { limitRead } from '@/lib/readGuard';

export const revalidate = 0;

export async function GET(request: NextRequest) {
  const limited = limitRead(request, 'history-stats');
  if (limited) return limited;
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const since = Date.now() - STATS_LOOKBACK_MS;
  const [stats, openSnap] = await Promise.all([getClosedPeriodStats(symbol, since), getOpenSnapStats(symbol, since)]);
  return NextResponse.json({ symbol, stats, openSnap });
}
