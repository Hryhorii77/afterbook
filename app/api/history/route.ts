import { NextRequest, NextResponse } from 'next/server';
import { getHistory } from '@/lib/history';

export const revalidate = 0;

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;

export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const sinceParam = request.nextUrl.searchParams.get('since');
  const since = sinceParam && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : Date.now() - DEFAULT_LOOKBACK_MS;

  const samples = await getHistory(symbol, since);
  return NextResponse.json({ symbol, since, samples });
}
