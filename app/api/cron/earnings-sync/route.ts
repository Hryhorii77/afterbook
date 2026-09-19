import { NextRequest, NextResponse } from 'next/server';
import { STOCKS } from '@/lib/tokens';
import { fetchNasdaqEarningsForDate, recordNextEarnings } from '@/lib/earningsCalendar';
import { syncEarningsMovesForDate } from '@/lib/earningsHistory';

export const revalidate = 0;
export const maxDuration = 30;

const SCAN_DAYS = 14;
// How many days back to check for a just-completed report to record into
// history — lagged (not "yesterday") so Yahoo's closing price for the
// reaction day has definitely settled, and past any adjacent weekend.
const HISTORY_SYNC_LAG_DAYS = 4;

// Scans a day-indexed calendar rather than a symbol-indexed one, so this
// walks forward day by day (Nasdaq's endpoint has no date-range param) and
// records, per ticker, the earliest date it shows up in the window. A
// ticker absent from the whole window (expected for a thin-history name
// like SPCX right now) just doesn't get a key — treated as "nothing
// scheduled," not an error.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const now = Date.now();
  const tickers = STOCKS.map((s) => s.cashTicker);
  const nextDateByTicker = new Map<string, string>();

  for (let i = 0; i < SCAN_DAYS; i++) {
    const date = new Date(now + i * 86_400_000);
    const dateStr = date.toISOString().slice(0, 10);
    const reporting = await fetchNasdaqEarningsForDate(dateStr);
    for (const ticker of tickers) {
      if (!nextDateByTicker.has(ticker) && reporting.has(ticker)) {
        nextDateByTicker.set(ticker, dateStr);
      }
    }
  }

  await Promise.all(
    STOCKS.map((stock) => recordNextEarnings(stock.symbol, nextDateByTicker.get(stock.cashTicker) ?? null, now)),
  );

  // Piggybacks the same daily run to grow lib/earningsHistory.ts's real
  // record of past reports — one extra day-scan, cheap, and naturally
  // no-ops (hasEarningsMove) once a date's already recorded.
  const historyDateStr = new Date(now - HISTORY_SYNC_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
  const historyRecorded = await syncEarningsMovesForDate(historyDateStr).catch(() => 0);

  return NextResponse.json({ ok: true, found: nextDateByTicker.size, historyRecorded });
}
