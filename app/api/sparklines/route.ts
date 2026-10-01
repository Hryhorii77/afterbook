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

// Thin a series to POINTS evenly spaced in time, taking the last sample in
// each slot, so a busy hour doesn't dominate the shape.
function bucket(samples: Point[], n: number): number[] {
  if (samples.length <= n) return samples.map((s) => s.priceUsd);
  const start = samples[0].ts;
  const span = samples[samples.length - 1].ts - start || 1;
  const out: number[] = [];
  let i = 0;
  for (let k = 1; k <= n; k++) {
    const end = start + (span * k) / n;
    while (i < samples.length - 1 && samples[i + 1].ts <= end) i++;
    out.push(samples[i].priceUsd);
  }
  return out;
}

// One request for every row: a time-bucketed price series over the stored
// window (up to 30 days) and the 24h change, both from the on-chain price
// samples already collected for the volatility maths. Cached for 2 minutes.
const getAll = unstable_cache(
  async () => {
    const now = Date.now();
    const series: Record<string, number[]> = {};
    const change24h: Record<string, number | null> = {};
    let oldest = now;
    await Promise.all(
      STOCKS.map(async (s) => {
        const samples = await getPriceHistory(s.symbol, now - WINDOW_DAYS * DAY_MS);
        series[s.symbol] = bucket(samples, POINTS);
        if (samples.length) oldest = Math.min(oldest, samples[0].ts);
        const latest = samples[samples.length - 1];
        const ref = samples.reduce<Point | null>(
          (best, p) => (best && Math.abs(best.ts - (now - DAY_MS)) <= Math.abs(p.ts - (now - DAY_MS)) ? best : p),
          null,
        );
        change24h[s.symbol] =
          latest && ref && Math.abs(ref.ts - (now - DAY_MS)) <= REF_TOLERANCE_MS ? (latest.priceUsd / ref.priceUsd - 1) * 100 : null;
      }),
    );
    // How much history the charts really cover, so the header never claims 30d
    // before there are 30 days of samples.
    const days = Math.max(1, Math.min(WINDOW_DAYS, Math.round((now - oldest) / DAY_MS)));
    return { series, change24h, days };
  },
  ['trend-30d-v1'],
  { revalidate: 120 },
);

export async function GET() {
  return NextResponse.json(await getAll());
}
