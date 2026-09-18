import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { sendTelegramMessage } from '@/lib/telegram';
import { getJensenBurnStatus, JENSEN_BUYBACK_BURN_ADDRESS } from '@/lib/jensenBurn';

export const revalidate = 0;
export const maxDuration = 30;

const NOTIFIED_KEY = 'jensen-burn:notified';

/** JensenBuybackBurn has no owner, no pause, and no self-trigger — anyone
 *  can call swapAndBurn() once its USDC balance crosses the deployed
 *  threshold, but nothing does so automatically. This only watches and
 *  notifies on the ready/not-ready transition (like /api/cron/alerts) —
 *  it never sends a transaction itself, so it needs no funded key. */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!redis || !adminChatId) {
    return NextResponse.json({ ok: false, reason: 'not configured' });
  }

  const { ready, usdcBalance } = await getJensenBurnStatus();
  const alreadyNotified = await redis.get(NOTIFIED_KEY);
  const usdcDisplay = (Number(usdcBalance) / 1e6).toFixed(2);

  if (ready && !alreadyNotified) {
    await sendTelegramMessage(
      adminChatId,
      `JENSEN buyback-burn is ready: $${usdcDisplay} USDC sitting at ${JENSEN_BUYBACK_BURN_ADDRESS}.\n\n` +
        `Anyone can call swapAndBurn() now (0.75% tip to whoever does):\n` +
        `cast send ${JENSEN_BUYBACK_BURN_ADDRESS} "swapAndBurn()" --rpc-url base --account <your-keystore>`
    );
    await redis.set(NOTIFIED_KEY, '1');
    return NextResponse.json({ ok: true, ready, usdcBalance: usdcDisplay, notified: true });
  }

  if (!ready && alreadyNotified) {
    // Balance dropped back below threshold (someone called it) — reset so
    // the next time it crosses $50 fires a fresh alert.
    await redis.del(NOTIFIED_KEY);
  }

  return NextResponse.json({ ok: true, ready, usdcBalance: usdcDisplay, notified: false });
}
