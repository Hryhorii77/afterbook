import { NextRequest, NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/sharedSecret';
import { swapStats } from '@/lib/swapLog';

export const revalidate = 0;

// Maintainer-only swap metrics (same auth as /api/clicks/stats): GET ?days=7 with the cron bearer.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? 7) || 7, 1), 365);
  const stats = await swapStats(days);
  return stats ? NextResponse.json(stats) : NextResponse.json({ error: 'store unavailable' }, { status: 503 });
}
