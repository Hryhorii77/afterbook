import { NextRequest, NextResponse } from 'next/server';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { planStats } from '@/lib/agent/planStats';
import { swapStats } from '@/lib/swap/swapLog';

export const revalidate = 0;

// Maintainer-only trade plan traction (same auth as /api/swap/stats): GET ?days=30 with the cron bearer.
// Plans made, Claude-explained and with a buy (lib/agent/planStats.ts), and the swaps signed from a
// plan: count, volume and distinct hashed wallets, verified onchain by the swap log.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const days = Math.min(Math.max(Number(request.nextUrl.searchParams.get('days') ?? 30) || 30, 1), 365);
  const [plans, swaps] = await Promise.all([planStats(days), swapStats(days)]);
  if (!plans || !swaps) return NextResponse.json({ error: 'store unavailable' }, { status: 503 });
  return NextResponse.json({ days, plans: plans.total, plansByDay: plans.byDay, planSwaps: swaps.bySource.plan, allSwaps: { swaps: swaps.swaps, traders: swaps.traders, volumeUsd: swaps.volumeUsd } });
}
