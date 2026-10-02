import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { STOCKS } from '@/lib/tokens';
import { getPriceHistory } from '@/lib/volatility';

export const revalidate = 0;

const WINDOW_DAYS = 30;
const POINTS = 48;
const DAY_MS = 24 * 60 * 60_000;
/** A 24h change is only reported when a sample exists within this distance of
 *  "24 hours ago", so a sparse gap never turns into a made-up number. */
const REF_TOLERANCE_MS = 3 * 60 * 60_000;

interface Point {
  ts: number;
  priceUsd: number;
}

// Put a series on the shared time axis [start, now] as POINTS evenly spaced slots,
// taking the last sample at or before each slot's end. A slot before the symbol's
// first sample is null (not stretched or invented), so a token with one day of
// history draws only the last sliver of a 15-day chart instead of masquerading as one.
function bucket(samples: Point[], start: number, end: number, n: number): (number | null)[] {
  const span = end - start || 1;
  const out: (number | null)[] = [];
  let i = -1;
  for (let k = 1; k <= n; k++) {
    const slotEnd = start + (span * k) / n;
    while (i + 1 < samples.length && samples[i + 1].ts <= slotEnd) i++;
    out.push(i >= 0 ? samples[i].priceUsd : null);
  }
  return out;
}

// One request for every row: a time-bucketed price series over the stored
// window (up to 30 days) and the 24h change, both from the on-chain price
// samples already collected for the volatility maths. Cached for 2 minutes.
const getAll = unstable_cache(
  async () => {
    const now = Date.now();
    const raw: Record<string, Point[]> = {};
    const change24h: Record<string, number | null> = {};
    const spanDays: Record<string, number> = {};
    let oldest = now;
    await Promise.all(
      STOCKS.map(async (s) => {
        const samples = await getPriceHistory(s.symbol, now - WINDOW_DAYS * DAY_MS);
        raw[s.symbol] = samples;
        if (samples.length) {
          oldest = Math.min(oldest, samples[0].ts);
          spanDays[s.symbol] = Number(((now - samples[0].ts) / DAY_MS).toFixed(1));
        } else {
          spanDays[s.symbol] = 0;
        }
        const latest = samples[samples.length - 1];
        const ref = samples.reduce<Point | null>(
          (best, p) => (best && Math.abs(best.ts - (now - DAY_MS)) <= Math.abs(p.ts - (now - DAY_MS)) ? best : p),
          null,
        );
        change24h[s.symbol] =
          latest && ref && Math.abs(ref.ts - (now - DAY_MS)) <= REF_TOLERANCE_MS ? (latest.priceUsd / ref.priceUsd - 1) * 100 : null;
      }),
    );
    // The shared axis starts at the oldest stored sample (capped at 30 days) and the
    // header's "Past Nd" is its length, so it never claims more than exists.
    const series: Record<string, (number | null)[]> = {};
    for (const s of STOCKS) series[s.symbol] = bucket(raw[s.symbol], oldest, now, POINTS);
    const days = Math.max(1, Math.min(WINDOW_DAYS, Math.round((now - oldest) / DAY_MS)));
    return { series, change24h, days, spanDays };
  },
  ['trend-30d-v2'],
  { revalidate: 120 },
);

export async function GET() {
  return NextResponse.json(await getAll());
}
