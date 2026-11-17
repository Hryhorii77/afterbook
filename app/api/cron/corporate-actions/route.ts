import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { syncMultiplierHistory } from '@/lib/stocks/multiplierHistory';

export const revalidate = 0;
// The first run scans every block since the tokens launched (about 190 log queries, 4 at a time).
export const maxDuration = 120;

// Daily: dividends and splits of the tracked stock tokens, read onchain (lib/stocks/multiplierHistory.ts).
// Read-only onchain; writes only its own Redis keys (corp:*). The stock pages show the result.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const res = await syncMultiplierHistory();
    if (res.ok && res.found > 0) revalidateTag('corp-actions', 'max');
    return NextResponse.json(res, { status: res.ok ? 200 : 503 });
  } catch (err) {
    console.error('[/api/cron/corporate-actions]', err);
    return NextResponse.json({ ok: false, error: 'scan failed' }, { status: 502 });
  }
}
