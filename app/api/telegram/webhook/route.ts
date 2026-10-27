import { NextRequest, NextResponse } from 'next/server';
import { findStock, STOCKS } from '@/lib/tokens';
import { getTape } from '@/lib/tape';
import { getRules, setRules, canAddRule, MAX_RULES_PER_CHAT, MAX_LOAN_RULES_PER_CHAT, REARM_RATIO, type AlertRule } from '@/lib/alerts';
import { getWalletLoans } from '@/lib/loanPositions';
import { loanStatusText, nextLoanState, parseWatchArgs, worstHealth, LOAN_REARM_FACTOR } from '@/lib/loanHealth';
import { sendTelegramMessage } from '@/lib/telegram';
import { secretMatches } from '@/lib/sharedSecret';

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const HELP_TEXT = `Afterbook alerts — cash close vs the Aero book, in shares.

/alert STOCK BP — ping when |basis| crosses that many bp, e.g. "/alert NVDA 50" (NVDAc works too). After an alert it re-arms once the gap falls back to 80% of the level or lower, so one stretch near the line is one message.
/close — ping once when the cash market closes, with every liquid name's basis
/watch 0xADDRESS [HEALTH] — warn when that wallet's Aave or Morpho stock loan on Base drops below that health (default 1.2; liquidation is below 1.00). It also checks health at Aero's price, which can move before the lending oracle does while the cash market is shut. One wallet per chat.
/loans — show the watched wallet's loans and health now
/list — show your active alerts
/stop — clear all your alerts

Read-only: a wallet address is public. The bot never asks you to connect a wallet or sign anything.`;

function newRuleId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function describeRule(rule: AlertRule): string {
  if (rule.type === 'basis') return `${rule.symbol}: |basis| > ${rule.thresholdBp}bp`;
  if (rule.type === 'loan') return `Loans of ${rule.wallet}: health below ${rule.thresholdHf}`;
  return 'Cash-close digest (all liquid names)';
}

async function handleCommand(chatId: number, text: string): Promise<string> {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split('@')[0]; // strip @BotName suffix from group chats

  if (cmd === '/start' || cmd === '/help') {
    return HELP_TEXT;
  }

  if (cmd === '/list') {
    const rules = await getRules(String(chatId));
    if (rules.length === 0) return 'No active alerts. Try "/alert NVDA 50", "/close" or "/watch 0xYOURADDRESS".';
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

  if (cmd === '/watch') {
    const parsed = parseWatchArgs(args);
    if (typeof parsed === 'string') return parsed;
    const rules = await getRules(String(chatId));
    const others = rules.filter((r) => r.type !== 'loan');
    const replacing = rules.length !== others.length;
    if (!replacing && !canAddRule(rules)) return `Max ${MAX_RULES_PER_CHAT} alerts per chat — /stop to clear and start over.`;

    // Read the loans now: the reply shows them, and the edge-trigger starts from today's state, so
    // a loan already below the line is reported here once rather than again on the next tick.
    let loans;
    try {
      loans = await getWalletLoans(parsed.wallet);
    } catch {
      return 'Could not read Aave and Morpho right now. Try again in a minute.';
    }
    const active = nextLoanState(false, loans.length ? Math.min(...loans.map(worstHealth)) : 'no-loans', parsed.threshold);
    // One wallet per chat (free tier): a new /watch replaces the old one.
    const kept = others.slice(0, MAX_RULES_PER_CHAT - MAX_LOAN_RULES_PER_CHAT);
    kept.push({ id: newRuleId(), type: 'loan', wallet: parsed.wallet, thresholdHf: parsed.threshold, active });
    await setRules(String(chatId), kept);
    const rearm = Number((parsed.threshold * LOAN_REARM_FACTOR).toFixed(2));
    return [
      `${replacing ? 'Now watching' : 'Watching'} ${parsed.wallet}: a message when a loan's health drops below ${parsed.threshold}, then again only after it has been back above ${rearm}.`,
      loanStatusText(parsed.wallet, loans),
      active ? `Already below ${parsed.threshold} now.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  if (cmd === '/loans') {
    const rule = (await getRules(String(chatId))).find((r) => r.type === 'loan' && r.wallet);
    if (!rule) return 'No wallet watched. Try "/watch 0xYOURADDRESS".';
    try {
      return loanStatusText(rule.wallet!, await getWalletLoans(rule.wallet as `0x${string}`));
    } catch {
      return 'Could not read Aave and Morpho right now. Try again in a minute.';
    }
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
  if (!secretMatches(WEBHOOK_SECRET, request.headers.get('x-telegram-bot-api-secret-token'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
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
