import { NextRequest, NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';
import { gliderConfigured, GliderError } from '@/lib/glider';
import { planTiltUpdate, applyTiltUpdate } from '@/lib/baskets/update';

export const revalidate = 0;
export const maxDuration = 30;

// Daily: recompute the smoothed Basis Tilt and, if enough of the basket would
// change, publish a new Glider strategy version. A published version makes
// every enrolled portfolio trade real money, so this only publishes when
// BASKET_AUTOPUBLISH=1 is set; otherwise (or with ?dry=1) it reports the plan
// and changes nothing.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const strategyId = process.env.GLIDER_STRATEGY_ID;
  if (!gliderConfigured() || !strategyId) return NextResponse.json({ ok: false, reason: 'baskets not configured' });

  try {
    const plan = await planTiltUpdate(strategyId, await getTape());
    const live = process.env.BASKET_AUTOPUBLISH === '1' && request.nextUrl.searchParams.get('dry') !== '1';
    const outcome = live ? await applyTiltUpdate(plan) : { published: false };
    return NextResponse.json({
      ok: true,
      mode: live ? 'live' : 'dry-run',
      currentVersion: plan.version,
      publish: plan.publish && !plan.blocked,
      blocked: plan.blocked,
      reason: plan.reason,
      turnoverPct: Number((plan.turnover * 100).toFixed(2)),
      weights: Object.fromEntries(plan.weights.map((w) => [w.symbol, w.weight])),
      ...outcome,
    });
  } catch (err) {
    if (err instanceof GliderError) return NextResponse.json({ ok: false, error: err.message, code: err.code }, { status: 502 });
    return NextResponse.json({ ok: false, error: 'unexpected error' }, { status: 500 });
  }
}
