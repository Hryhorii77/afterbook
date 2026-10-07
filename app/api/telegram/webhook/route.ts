import { NextRequest, NextResponse } from 'next/server';
import { findStock, STOCKS } from '@/lib/tokens';
import { getTape } from '@/lib/tape';
import { getRules, setRules, canAddRule, MAX_RULES_PER_CHAT, REARM_RATIO, type AlertRule } from '@/lib/alerts';
import { sendTelegramMessage } from '@/lib/telegram';

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const HELP_TEXT = `Afterbook alerts — cash close vs the Aero book, in shares.

/alert STOCK BP — ping when |basis| crosses that many bp, e.g. "/alert NVDA 50" (NVDAc works too). After an alert it re-arms once the gap falls back to 80% of the level or lower, so one stretch near the line is one message.
/close — ping once when the cash market closes, with every liquid name's basis
/list — show your active alerts
/stop — clear all your alerts

Read-only, no wallet, nothing signed — same as the site.`;

function newRuleId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function describeRule(rule: AlertRule): string {
  return rule.type === 'basis' ? `${rule.symbol}: |basis| > ${rule.thresholdBp}bp` : 'Cash-close digest (all liquid names)';
}

async function handleCommand(chatId: number, text: string): Promise<string> {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split('@')[0]; // strip @BotName suffix from group chats

  if (cmd === '/start' || cmd === '/help') {
    return HELP_TEXT;
  }

  if (cmd === '/list') {
    const rules = await getRules(String(chatId));
    if (rules.length === 0) return 'No active alerts. Try "/alert NVDA 50" or "/close".';
    return rules.map(describeRule).join('\n');
  }

  if (cmd === '/stop') {
    await setRules(String(chatId), []);
    return 'Cleared all alerts.';
  }

  if (cmd === '/close') {
    const rules = await getRules(String(chatId));
    if (rules.some((r) => r.type === 'close')) return 'Already subscribed to the cash-close digest.';
    if (!canAddRule(rules)) return `Max ${MAX_RULES_PER_CHAT} alerts per chat — /stop to clear and start over.`;
    rules.push({ id: newRuleId(), type: 'close', active: false });
    await setRules(String(chatId), rules);
    return 'Subscribed — you’ll get a ping the moment the cash market closes.';
  }

  if (cmd === '/alert') {
    const [symbolArg, bpArg] = args;
    if (!symbolArg || !bpArg) return 'Usage: /alert STOCK BP — e.g. "/alert NVDA 50"';

    const stock = findStock(symbolArg);
    if (!stock) return `Unknown stock "${symbolArg}". Tracked: ${STOCKS.map((s) => s.cashTicker).join(', ')}.`;

    const thresholdBp = Number(bpArg);
    if (!Number.isFinite(thresholdBp) || thresholdBp <= 0) return 'BP threshold must be a positive number.';

    const rules = await getRules(String(chatId));
    if (rules.some((r) => r.type === 'basis' && r.symbol === stock.symbol && r.thresholdBp === thresholdBp)) {
      return `Already set: ${stock.symbol} |basis| > ${thresholdBp}bp.`;
    }
    if (!canAddRule(rules)) return `Max ${MAX_RULES_PER_CHAT} alerts per chat — /stop to clear and start over.`;

    // Seed the edge-trigger state from the current tape so a threshold
    // that's already crossed right now doesn't fire immediately — only a
    // future crossing does.
    let active = false;
    try {
      const tape = await getTape();
      const row = tape.rows.find((r) => r.symbol === stock.symbol);
      active = row?.basisBp != null && Math.abs(row.basisBp) > thresholdBp;
    } catch {
      // fall through with active=false — worst case this one fires on the
      // next tick even if already past threshold, not a big deal
    }

    rules.push({ id: newRuleId(), type: 'basis', symbol: stock.symbol, thresholdBp, active });
    await setRules(String(chatId), rules);
    return `Set: ${stock.symbol} |basis| > ${thresholdBp}bp. After an alert it re-arms once the gap is back to ${Number((thresholdBp * REARM_RATIO).toFixed(1))}bp or lower.`;
  }

  return `Unknown command. ${HELP_TEXT}`;
}

export async function POST(request: NextRequest) {
  if (WEBHOOK_SECRET) {
    const header = request.headers.get('x-telegram-bot-api-secret-token');
    if (header !== WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const update = await request.json().catch(() => null);
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text;

  if (typeof chatId === 'number' && typeof text === 'string') {
    const reply = await handleCommand(chatId, text);
    await sendTelegramMessage(chatId, reply);
  }

  // Telegram only cares about a 200 — it doesn't do anything with the body.
  return NextResponse.json({ ok: true });
}
