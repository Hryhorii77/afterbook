import { NextResponse } from 'next/server';
import { unstable_cache } from 'next/cache';
import { STOCKS } from '@/lib/tokens';
import { getPriceHistory } from '@/lib/volatility';

export const revalidate = 0;

const WINDOW_MS = 24 * 60 * 60_000;
const POINTS = 32;

function downsample(values: number[], n: number): number[] {
  if (values.length <= n) return values;
  return Array.from({ length: n }, (_, i) => values[Math.round((i / (n - 1)) * (values.length - 1))]);
}

// One request for every row's trend line, instead of ten. The on-chain price
// samples are already collected for the volatility maths; this just reads the
// last 24h, thins each series to ~32 points, and caches the result for 2 min.
const getAll = unstable_cache(
  async () => {
    const since = Date.now() - WINDOW_MS;
    const out: Record<string, number[]> = {};
    await Promise.all(
      STOCKS.map(async (s) => {
        const samples = await getPriceHistory(s.symbol, since);
        out[s.symbol] = downsample(samples.map((x) => x.priceUsd), POINTS);
      }),
    );
    return out;
  },
  ['sparklines-24h'],
  { revalidate: 120 },
);

export async function GET() {
  return NextResponse.json({ series: await getAll() });
}
