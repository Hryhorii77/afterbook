import { NextRequest, NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';
import { splitByLiquidity } from '@/lib/liquidity';
import { getAllChatIds, getRules, setRules, type AlertRule } from '@/lib/alerts';
import { sendTelegramMessage } from '@/lib/telegram';
import { bp } from '@/lib/format';

export const revalidate = 0;
export const maxDuration = 30;

// Re-evaluates every rule from current state on every tick rather than
// tracking anything incrementally — Vercel's own guidance is that cron
// delivery can occasionally double-invoke or skip a run, so a duplicate or
// missed tick has to self-correct on the next one instead of compounding.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const tape = await getTape().catch(() => null);
  if (!tape) return NextResponse.json({ ok: false, reason: 'tape unavailable' });

  const marketClosed = tape.session.state !== 'open';
  const { liquid } = splitByLiquidity(tape.rows);
  const closeDigest = `Cash closed. ${liquid.map((r) => `${r.cashTicker} Aero ${bp(r.basisBp)}`).join(' ')}`;

  const chatIds = await getAllChatIds();
  let sent = 0;

  for (const chatId of chatIds) {
    const rules = await getRules(chatId);
    if (rules.length === 0) continue;

    let changed = false;
    const updated: AlertRule[] = [];

    for (const rule of rules) {
      let nowActive = rule.active;
      let message: string | null = null;

      if (rule.type === 'close') {
        nowActive = marketClosed;
        if (nowActive && !rule.active) message = closeDigest;
      } else if (rule.type === 'basis' && rule.symbol && rule.thresholdBp != null) {
        const row = tape.rows.find((r) => r.symbol === rule.symbol);
        nowActive = row?.basisBp != null && Math.abs(row.basisBp) > rule.thresholdBp;
        if (nowActive && !rule.active) {
          message = `${rule.symbol} |basis| crossed ${rule.thresholdBp}bp — now ${bp(row!.basisBp)}.`;
        }
      }

      if (message) {
        await sendTelegramMessage(chatId, message);
        sent += 1;
      }
      if (nowActive !== rule.active) changed = true;
      updated.push({ ...rule, active: nowActive });
    }

    if (changed) await setRules(chatId, updated);
  }

  return NextResponse.json({ ok: true, chats: chatIds.length, sent });
}
