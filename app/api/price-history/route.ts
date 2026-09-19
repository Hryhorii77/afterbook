import { NextRequest, NextResponse } from 'next/server';
import { getPriceHistory } from '@/lib/volatility';

export const revalidate = 0;

const LOOKBACK_MS = 30 * 24 * 60 * 60_000;

// Raw price samples (distinct from /api/history's basisBp samples) so the
// client can run computeInRangeProbabilityPct itself on every drag frame
// of the Lot Lab range selector — hitting a route per pixel of movement
// isn't viable, so this ships the samples once per symbol instead.
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get('symbol');
  if (!symbol) {
    return NextResponse.json({ error: 'symbol required' }, { status: 400 });
  }

  const samples = await getPriceHistory(symbol, Date.now() - LOOKBACK_MS);
  return NextResponse.json({ symbol, samples });
}
