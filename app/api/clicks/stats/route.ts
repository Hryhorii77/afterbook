import { NextRequest, NextResponse } from 'next/server';
import { getDailyClickStats, getRecentClicks } from '@/lib/clicks';

export const revalidate = 0;

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

interface DaySummary {
  day: string;
  count: number;
  usdIn: number;
  bySymbol: Record<string, number>;
}

// Maintainer-only read of the outbound-click log (lib/clicks.ts) — the raw
// material for a partner/referral pitch (see CLAUDE.md's context on why
// this exists). Reuses CRON_SECRET rather than inventing a second admin
// env var: it's already the one bearer token this app treats as
// "maintainer, not the public," and adding a new env var means a Vercel
// redeploy this route shouldn't need to wait on.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  // No CRON_SECRET configured (e.g. local dev) falls through unauthenticated
  // — same posture as the cron routes this pattern is borrowed from.

  const { searchParams } = new URL(request.url);
  const days = Math.min(Math.max(Number(searchParams.get('days')) || 7, 1), 30);
  const recentLimit = Math.min(Math.max(Number(searchParams.get('recent')) || 100, 0), 500);

  const dayStrings = Array.from({ length: days }, (_, i) => dateNDaysAgo(i));
  const rawStats = await Promise.all(dayStrings.map((day) => getDailyClickStats(day)));

  const byDay: DaySummary[] = dayStrings.map((day, i) => {
    const raw = rawStats[i];
    const summary: DaySummary = { day, count: 0, usdIn: 0, bySymbol: {} };
    if (!raw) return summary;
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'count') summary.count = Number(value) || 0;
      else if (key === 'usdIn') summary.usdIn = Number(value) || 0;
      else if (key.startsWith('symbol:')) summary.bySymbol[key.slice('symbol:'.length)] = Number(value) || 0;
    }
    return summary;
  });

  const totals = byDay.reduce(
    (acc, d) => ({ count: acc.count + d.count, usdIn: acc.usdIn + d.usdIn }),
    { count: 0, usdIn: 0 },
  );

  const recent = recentLimit > 0 ? await getRecentClicks(recentLimit) : [];

  return NextResponse.json({ totals, byDay, recent });
}
