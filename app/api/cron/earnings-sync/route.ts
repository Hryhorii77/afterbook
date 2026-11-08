import { NextRequest, NextResponse } from 'next/server';
import { STOCKS } from '@/lib/stocks/tokens';
import { recordEarningsSynced, recordNextEarnings, scanNextEarnings } from '@/lib/stocks/earningsCalendar';
import { syncEarningsMovesForDate } from '@/lib/stocks/earningsHistory';
import { cronAuthorized } from '@/lib/server/sharedSecret';

export const revalidate = 0;
// 15 days fetched one after another, each given up to 5 s, plus the history day: 30 s was too tight.
export const maxDuration = 120;

// How many days back to check for a just-completed report to record into
// history — lagged (not "yesterday") so Yahoo's closing price for the
// reaction day has definitely settled, and past any adjacent weekend.
const HISTORY_SYNC_LAG_DAYS = 4;

// Scans Nasdaq's day-indexed calendar EARNINGS_SCAN_DAYS ahead (scanNextEarnings). After a full scan a
// ticker absent from the whole window has nothing scheduled and its key is removed; if any day's fetch
// failed, dates are only added or moved (lib/stocks/earningsCalendar.ts).
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = Date.now();
  const { next, failedDays } = await scanNextEarnings(STOCKS.map((s) => s.cashTicker), now);

  if (failedDays.length === 0) {
    // A full scan: a ticker missing from every day has no report in the window, so its old date goes.
    await Promise.all(STOCKS.map((stock) => recordNextEarnings(stock.symbol, next.get(stock.cashTicker) ?? null, now)));
    await recordEarningsSynced(now);
  } else {
    // Some days failed: a missing ticker may just be on one of them. Only add or move dates that were
    // found, never delete, and leave earnings:syncedAt alone so the trade plan says it couldn't confirm.
    await Promise.all(
      STOCKS.flatMap((stock) => {
        const date = next.get(stock.cashTicker);
        return date ? [recordNextEarnings(stock.symbol, date, now)] : [];
      }),
    );
  }

  // Piggybacks the same daily run to grow lib/stocks/earningsHistory.ts's real
  // record of past reports — one extra day-scan, cheap, and naturally
  // no-ops (hasEarningsMove) once a date's already recorded.
  const historyDateStr = new Date(now - HISTORY_SYNC_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
  const historyRecorded = await syncEarningsMovesForDate(historyDateStr).catch(() => 0);

  return NextResponse.json({ ok: failedDays.length === 0, found: next.size, failedDays, historyRecorded });
}
