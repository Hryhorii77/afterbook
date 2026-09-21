import { NextRequest, NextResponse } from 'next/server';
import { getClosedPeriodStats, getOpenSnapStats } from '@/lib/history';

export const revalidate = 0;

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const since = Date.now() - LOOKBACK_MS;
  const [stats, openSnap] = await Promise.all([getClosedPeriodStats(symbol, since), getOpenSnapStats(symbol, since)]);
  return NextResponse.json({ symbol, stats, openSnap });
}
