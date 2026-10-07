import { NextRequest, NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';
import { gliderConfigured, GliderError } from '@/lib/glider';
import { planTiltUpdate, applyTiltUpdate, saveTiltEma } from '@/lib/baskets/update';
import { sendTelegramMessage } from '@/lib/telegram';

export const revalidate = 0;
export const maxDuration = 30;

// Daily: recompute the smoothed Basis Tilt and, if enough of the basket would
// change, publish a new Glider strategy version. A published version makes
// every enrolled portfolio trade real money, so this only publishes when
// BASKET_AUTOPUBLISH=1 is set; otherwise (or with ?dry=1) it reports the plan
// and publishes nothing (a scheduled run still saves the moving average; ?dry=1 writes
// nothing at all). Each publish is announced to TELEGRAM_ADMIN_CHAT_ID.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }
  const strategyId = process.env.GLIDER_STRATEGY_ID?.trim();
  if (!gliderConfigured() || !strategyId) return NextResponse.json({ ok: false, reason: 'baskets not configured' });

  try {
    const plan = await planTiltUpdate(strategyId, await getTape());
    const autopublishEnabled = process.env.BASKET_AUTOPUBLISH === '1';
    const dryRequest = request.nextUrl.searchParams.get('dry') === '1';
    const live = autopublishEnabled && !dryRequest;
    // A scheduled run with auto-publish off still saves the moving average (a ?dry=1 request never writes).
    if (!live && !dryRequest) await saveTiltEma(plan);
    const outcome: { published: boolean; version?: number } = live ? await applyTiltUpdate(plan) : { published: false };
    // A publish makes every enrolled portfolio trade: tell the owner when it happens.
    const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (outcome.published && adminChatId) {
      const top = plan.weights.slice().sort((a, b) => b.weightHundredths - a.weightHundredths).slice(0, 4).map((w) => `${w.symbol} ${w.weight}%`).join(', ');
      await sendTelegramMessage(adminChatId, `Basis Tilt v${outcome.version} published (${plan.reason}). Largest weights: ${top}. Every enrolled portfolio rebalances to it.`).catch(() => {});
    }
    return NextResponse.json({
      ok: true,
      mode: live ? 'live' : 'dry-run',
      autopublishEnabled,
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
