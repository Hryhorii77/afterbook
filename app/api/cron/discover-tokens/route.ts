import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { sendTelegramMessage } from '@/lib/telegram';
import { fetchPublishedStockList, diffAgainstTracked, verifyCandidate } from '@/lib/discovery';

export const revalidate = 0;
export const maxDuration = 30;

const NOTIFIED_KEY = 'discover:notified';

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
    return NextResponse.json({ ok: false, reason: 'discovery not configured' });
  }

  const published = await fetchPublishedStockList().catch(() => null);
  if (!published) return NextResponse.json({ ok: false, reason: 'stock list fetch failed' });

  const newTickers = diffAgainstTracked(published);
  if (newTickers.length === 0) return NextResponse.json({ ok: true, newCandidates: 0 });

  const alreadyNotified = await redis.smembers(NOTIFIED_KEY);
  const notifiedSet = new Set(alreadyNotified);
  const toCheck = newTickers.filter((t) => !notifiedSet.has(t.symbol));
  if (toCheck.length === 0) return NextResponse.json({ ok: true, newCandidates: newTickers.length, notified: 0 });

  let notified = 0;
  for (const candidate of toCheck) {
    const result = await verifyCandidate(candidate.symbol, candidate.tokenAddress).catch(() => null);
    if (!result) continue;

    const message = result.snippet
      ? `New tokenized stock candidate: ${result.symbol} (${result.tokenAddress})\n\nLive Aerodrome pool found. Ready-to-paste STOCKS entry:\n\n${result.snippet}`
      : `New tokenized stock candidate: ${result.symbol} (${result.tokenAddress})\n\nNo Aerodrome USDC pool found yet — nothing to add until one exists.`;

    await sendTelegramMessage(adminChatId, message);
    await redis.sadd(NOTIFIED_KEY, candidate.symbol);
    notified += 1;
  }

  return NextResponse.json({ ok: true, newCandidates: newTickers.length, notified });
}
