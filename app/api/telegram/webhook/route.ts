import { NextRequest, NextResponse } from 'next/server';
import { findStock, STOCKS } from '@/lib/stocks/tokens';
import { longBreakClose } from '@/lib/market/marketClock';
import { getTape } from '@/lib/market/tape';
import { getRules, setRules, canAddRule, MAX_RULES_PER_CHAT, MAX_LOAN_RULES_PER_CHAT, REARM_RATIO, type AlertRule } from '@/lib/alerts/alerts';
import { getWalletLoans } from '@/lib/lending/loanPositions';
import { DEFAULT_ALERT_HEALTH, loanStatusText, loansReplyText, nextLoanState, parseWatchArgs, worstHealth, LOAN_REARM_FACTOR } from '@/lib/lending/loanHealth';
import { rescueLinks } from '@/lib/lending/rescueLink';
import { sendTelegramMessage } from '@/lib/alerts/telegram';
import { secretMatches } from '@/lib/server/sharedSecret';
import { redis } from '@/lib/server/redis';
import { parsePlanInput } from '@/lib/agent/plan';
import { runPlan, runBrief } from '@/lib/agent/runPlan';
import { parseBriefInput } from '@/lib/agent/brief';
import { saveStockPlan, saveBasket } from '@/lib/agent/savedPlan';
import { hasLinkableBuy, planLinkPath } from '@/lib/agent/planLink';
import { siteUrl } from '@/lib/share/siteUrl';
import { mcpPlanLimiter, planLinkDailyLimiter } from '@/lib/server/ratelimit';
import { parsePlanCommand, planReplyText } from '@/lib/alerts/telegramPlan';
import { parseBasketCommand, basketReplyText } from '@/lib/alerts/telegramBasket';

// A /plan reads pools for each stock before it replies.
export const maxDuration = 60;
const PLAN_TIMEOUT_MS = 25_000;

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const HELP_TEXT = `Afterbook alerts — cash close vs the Aero book, in shares.

/alert STOCK BP — ping when |basis| crosses that many bp, e.g. "/alert NVDA 50" (NVDAc works too). After an alert it re-arms once the gap falls back to 80% of the level or lower, so one stretch near the line is one message.
/close — ping once when the cash market closes, with every liquid name's basis
/watch 0xADDRESS [HEALTH] — warn when that wallet's Aave or Morpho stock loan on Base drops below that health (default 1.2; liquidation is below 1.00). It also checks health at Aero's price, which can move before the lending oracle does while the cash market is shut. One wallet per chat.
/loans — show the watched wallet's loans and health now, with links to repay or add collateral on Afterbook's Aave panel when health is near your alert (you sign there yourself)
/plan STOCK [STOCK…] USD — a checked buy plan, e.g. "/plan NVDA 100": a buy, wait or skip per stock with a size within $25k and 10% of the pool, and a link to afterbook.app where you sign each buy in your own wallet after the checks run again
/basket [THEME] USD [STOCKS] — a basket the code picks, e.g. "/basket tech 100": the deepest steady pools that pass the checks, 3 to 4 stocks in equal amounts (a last number of 2 to 4 sets the fewest), and a link to afterbook.app where you sign the basket buy yourself. Themes: any, tech, chips, memory, software, internet, consumer, ev, health, china, global, bitcoin, space
/list — show your active alerts
/stop — clear all your alerts

Read-only: a wallet address is public. The bot never asks you to connect a wallet or sign anything; a /plan or /basket link opens afterbook.app, where you connect and sign each buy yourself. Trading is not available in the US or its territories. Checked by code, not advice.`;

const PLAN_WELCOME = `Plans from Afterbook, here in Telegram.

/plan NVDA 100 — a buy, wait or skip for each stock you name (up to 4), sized within your budget
/basket tech 100 — a basket the code picks: the deepest steady pools that pass (themes: any, tech, chips, memory, software, internet, consumer, ev, health, china, global, bitcoin, space)

Each reply has a link to afterbook.app. Open it, connect your own wallet, and the checks run again before you sign each buy yourself. The bot never asks for a wallet or a signature. Not available in the US or its territories. Checked by code, not advice.

/help lists everything else: gap alerts, the close digest and loan alerts.`;

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

  // The site's "Get plans in Telegram" button opens t.me/afterbook_bot?start=plan, which arrives as "/start plan".
  if (cmd === '/start' && args[0] === 'plan') return PLAN_WELCOME;
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
    // Watched during a weekend or holiday break: the reply below already shows the loan, so that break's heads-up isn't sent again.
    const breakClose = longBreakClose();
    kept.push({ id: newRuleId(), type: 'loan', wallet: parsed.wallet, thresholdHf: parsed.threshold, active, ...(breakClose ? { breakSent: breakClose } : {}) });
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
      const loans = await getWalletLoans(rule.wallet as `0x${string}`);
      // Read-only, as /watch: the links carry no amount or wallet (the panel works it out from the wallet that connects).
      const aave = loans.find((l) => l.venue === 'aave');
      const threshold = rule.thresholdHf ?? DEFAULT_ALERT_HEALTH;
      return loansReplyText(rule.wallet!, loans, threshold, aave ? rescueLinks(aave, threshold, siteUrl) : null);
    } catch {
      return 'Could not read Aave and Morpho right now. Try again in a minute.';
    }
  }

  if (cmd === '/plan') {
    const parsed = parsePlanCommand(args, (n) => findStock(n)?.symbol);
    if (typeof parsed === 'string') return parsed;
    // Same checks as /plan and the MCP make_plan tool, in fixed words (never Claude), at the default limits.
    const input = parsePlanInput({ symbols: parsed.symbols, budgetUsd: parsed.budgetUsd }, (sym) => !!findStock(sym));
    if (typeof input === 'string') return `Can't plan that: ${input}.`;
    // Per chat across instances, with the MCP plan tools' limit (10 a minute); its own key space.
    if (mcpPlanLimiter && !(await mcpPlanLimiter.limit(`tg:${chatId}`)).success) return 'Too many plans in a minute. Try again shortly.';
    try {
      // Well inside the function's 60 s: a run that hit the limit would answer 5xx and Telegram would resend the update.
      const out = await Promise.race([
        runPlan(input, new Request(siteUrl), { explain: false }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('plan timed out')), PLAN_TIMEOUT_MS)),
      ]);
      let id: string | null = null;
      let linkRefused = false;
      if (hasLinkableBuy(out.plan)) {
        // The same site-wide daily ceiling on saved links as the MCP tools.
        linkRefused = !!planLinkDailyLimiter && !(await planLinkDailyLimiter.limit('all')).success;
        if (!linkRefused) id = await saveStockPlan(input, out, 'telegram');
      }
      return planReplyText(out.plan, input, id ? `${siteUrl}${planLinkPath(id)}` : null, linkRefused);
    } catch (e) {
      console.error('[telegram /plan]', e);
      return 'Could not make a plan right now. Try again in a minute.';
    }
  }

  if (cmd === '/basket') {
    const parsed = parseBasketCommand(args);
    if (typeof parsed === 'string') return parsed;
    // The basket tab's and the MCP make_basket tool's code (fixed words, never Claude), at the page's default limits;
    // the theme is a fixed one, never free text.
    const input = parseBriefInput({ theme: parsed.theme, exclude: parsed.exclude, budgetUsd: parsed.budgetUsd, minStocks: parsed.minStocks });
    if (typeof input === 'string') return `Can't make that basket: ${input}.`;
    // Shares /plan's per-chat limit (10 a minute across instances).
    if (mcpPlanLimiter && !(await mcpPlanLimiter.limit(`tg:${chatId}`)).success) return 'Too many plans in a minute. Try again shortly.';
    try {
      const out = await Promise.race([
        runBrief(input, new Request(siteUrl), { explain: false }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('basket timed out')), PLAN_TIMEOUT_MS)),
      ]);
      let id: string | null = null;
      let linkRefused = false;
      if (out.brief.basket) {
        linkRefused = !!planLinkDailyLimiter && !(await planLinkDailyLimiter.limit('all')).success;
        if (!linkRefused) id = await saveBasket(out, 'telegram');
      }
      return basketReplyText(out.brief, input, parsed.label, parsed.command, id ? `${siteUrl}${planLinkPath(id)}` : null, linkRefused);
    } catch (e) {
      console.error('[telegram /basket]', e);
      return 'Could not make a basket right now. Try again in a minute.';
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

  // Telegram resends an update it thinks failed (a slow or 5xx answer): answer each update once (2026-11-22), so a
  // resent /plan doesn't run, save a link and reply twice. A failed check lets it through (a rare second reply).
  const updateId = update?.update_id;
  if (redis && typeof updateId === 'number') {
    const first = await redis.set(`tgupd:${updateId}`, 1, { nx: true, ex: 3600 }).catch(() => 'OK');
    if (first == null) return NextResponse.json({ ok: true });
  }

  if (typeof chatId === 'number' && typeof text === 'string') {
    const reply = await handleCommand(chatId, text);
    await sendTelegramMessage(chatId, reply);
  }

  // Telegram only cares about a 200 — it doesn't do anything with the body.
  return NextResponse.json({ ok: true });
}
