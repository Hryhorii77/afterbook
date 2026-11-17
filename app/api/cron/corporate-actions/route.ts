import { NextRequest, NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { syncMultiplierHistory } from '@/lib/stocks/multiplierHistory';

export const revalidate = 0;
// The first full scan takes about 250 s (2 chunks at a time, one query per 10 tokens), so each run stops
// after 75 s and the next carries on from the cursor.
export const maxDuration = 120;

// Daily: dividends and splits of the tracked stock tokens, read onchain (lib/stocks/multiplierHistory.ts).
// Read-only onchain; writes only its own Redis keys (corp:*). The stock pages show the result.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const res = await syncMultiplierHistory();
    if (res.ok && (res.found > 0 || res.becameReady)) revalidateTag('corp-actions', 'max');
    return NextResponse.json(res, { status: res.ok ? 200 : 503 });
  } catch (err) {
    console.error('[/api/cron/corporate-actions]', err);
    return NextResponse.json({ ok: false, error: 'scan failed' }, { status: 502 });
  }
}
