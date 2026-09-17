import { NextRequest, NextResponse } from 'next/server';
import { STOCKS } from '@/lib/tokens';
import { readPoolState, poolDepth } from '@/lib/quote';
import { recordFeeSnapshot } from '@/lib/feeApr';

export const revalidate = 0;
export const maxDuration = 30;

// Snapshots every stock's pool-wide feeGrowthGlobal0X128/1X128 once a day so
// lib/feeApr.ts can take a delta between two runs to compute fee APR. Not
// gated on liquidity — a currently-thin pool that deepens later shouldn't
// have to wait another cold-start period just because it wasn't liquid on
// day one.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const now = Date.now();
  let snapped = 0;

  await Promise.all(
    STOCKS.map(async (stock) => {
      try {
        const state = await readPoolState(stock);
        const depth = poolDepth(state, stock);
        await recordFeeSnapshot(stock.symbol, state.feeGrowthGlobal0X128, state.feeGrowthGlobal1X128, state.liquidity, depth.totalUsd, now);
        snapped += 1;
      } catch {
        // best-effort — a missed snapshot just widens the next APR window
      }
    }),
  );

  return NextResponse.json({ ok: true, snapped });
}
