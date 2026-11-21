import { NextRequest, NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { swapStats } from '@/lib/swap/swapLog';

export const revalidate = 0;

// Maintainer-only swap metrics (same auth as /api/clicks/stats): GET ?days=7 with the cron bearer. Test wallets
// (lib/swap/testWallets.ts) are left out and counted in `testsLeftOut`; ?tests=1 includes them.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? 7) || 7, 1), 365);
  const stats = await swapStats(days, { includeTests: request.nextUrl.searchParams.get('tests') === '1' });
  // Maintainer data: never kept by a shared cache.
  return stats ? NextResponse.json(stats, { headers: { 'Cache-Control': 'private, no-store' } }) : NextResponse.json({ error: 'store unavailable' }, { status: 503 });
}
