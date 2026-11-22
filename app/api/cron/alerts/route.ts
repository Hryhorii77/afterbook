import { NextRequest, NextResponse } from 'next/server';
import { getTape, recordTapeSamples } from '@/lib/market/tape';
import { recordDepthSample } from '@/lib/market/depthSamples';
import { splitByLiquidity } from '@/lib/market/liquidity';
import { getAllChatIds, getRulesOrNull, getRulesMany, rotate, setRules, nextBasisState, stateAfterSend, type AlertRule } from '@/lib/alerts/alerts';
import { sendTelegramMessageStatus } from '@/lib/alerts/telegram';
import { randomUUID } from 'node:crypto';
import { redis } from '@/lib/server/redis';
import { bp } from '@/lib/format';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { getWalletLoans } from '@/lib/lending/loanPositions';
import { AUTO_PICK_HOLD } from '@/lib/agent/limits';
import { longBreakClose, nextOpenWeekday } from '@/lib/market/marketClock';
import { loanAlertText, longBreakText, loanReadFailText, nextLoanState, worstHealth, LOAN_READ_FAIL_NOTICE, type WalletLoan } from '@/lib/lending/loanHealth';
import { rescueLinks } from '@/lib/lending/rescueLink';
import { siteUrl } from '@/lib/share/siteUrl';

export const revalidate = 0;
export const maxDuration = 60;

// Re-evaluates every rule from current state on every tick rather than
// tracking anything incrementally — Vercel's own guidance is that cron
// delivery can occasionally double-invoke or skip a run, so a duplicate or
// missed tick has to self-correct on the next one instead of compounding.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const tape = await getTape().catch(() => null);
  if (!tape) return NextResponse.json({ ok: false, reason: 'tape unavailable' });
  // A tape with `error` is the last good one, carried over after a failed fetch: its depths are not a
  // new reading, so no depth sample (a stale "fresh" reading would keep a pool in a basket).
  await Promise.all([recordTapeSamples(tape.rows), tape.error ? null : recordDepthSample(tape.rows, tape.fetchedAt)]);

  const marketClosed = tape.session.state !== 'open';
  // New listings held out of automatic picks (AUTO_PICK_HOLD) stay out of the close digest too.
  const { liquid } = splitByLiquidity(tape.rows.filter((r) => !AUTO_PICK_HOLD[r.symbol]));
  const closeDigest = `Cash closed. ${liquid.map((r) => `${r.cashTicker} Aero ${bp(r.basisBp)}`).join(' ')}`;

  // One run at a time sends: Vercel can double-invoke a cron, and two runs reading the same rules would
  // both send the same alert. The samples above are written either way (review of #212).
  const lockToken = randomUUID();
  if (redis && (await redis.set(ALERTS_LOCK, lockToken, { nx: true, ex: 120 }).catch(() => 'OK')) == null) {
    return NextResponse.json({ ok: true, skipped: 'another run is sending' });
  }
  try {
    return NextResponse.json(await evaluateRules(tape, marketClosed, closeDigest));
  } finally {
    if (redis) await redis.eval(RELEASE_LOCK, [ALERTS_LOCK], [lockToken]).catch(() => {});
  }
}

const ALERTS_LOCK = 'alerts:lock';
/** Chats checked at once (each may wait on a loan read or a Telegram send; Telegram allows ~30 messages a second). */
const CHAT_CONCURRENCY = 8;
/** Stop starting new chats after this long (counted from the start of the chat checks, after the tape and samples).
 *  A chat started just before it takes at most a 10 s loan read, a 10 s Telegram send and a few Redis requests, so
 *  the checks end inside the function's 60 s unless the tape build before them was unusually slow; the 120 s lock
 *  covers that case. */
const CHAT_BUDGET_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function evaluateRules(tape: NonNullable<Awaited<ReturnType<typeof getTape>>>, marketClosed: boolean, closeDigest: string) {
  const chatIds = await getAllChatIds();
  let sent = 0;
  // Inside a weekend or holiday break: the close that started it, for the loan heads-up (once per close per rule).
  const breakClose = longBreakClose();
  const breakOpenDay = breakClose ? nextOpenWeekday() : '';
  // One read per wallet per tick, shared by every chat watching it. null = the read failed: the
  // rule keeps its state (nextLoanState), so a flaky RPC can't fire or re-arm an alert.
  const walletReads = new Map<string, Promise<WalletLoan[] | null>>();
  const loansOf = (wallet: string) => {
    // At most 10 s: a slow read counts as a failed one (state kept), so one wallet can't hold the run past its limit.
    if (!walletReads.has(wallet)) walletReads.set(wallet, Promise.race([getWalletLoans(wallet as `0x${string}`), new Promise<null>((r) => setTimeout(() => r(null), READ_TIMEOUT_MS))]).catch(() => null));
    return walletReads.get(wallet)!;
  };

  // All rules in a few MGETs, then the chats several at a time (a loan read or a Telegram send no longer holds
  // up every chat after it), within a time budget under the function's 60 s. A run that stops early says so in
  // the log and its reply; each run starts at a random chat, so the same chats aren't always the ones left.
  const started = Date.now();
  const rulesByChat = await getRulesMany(chatIds);
  // A random starting point each run: if the budget ever cuts a run short, no chat is left at the end every time.
  const order = rotate(chatIds, Math.floor(Math.random() * Math.max(chatIds.length, 1)));
  let checked = 0;
  let unread = 0;
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < order.length && Date.now() - started < CHAT_BUDGET_MS) {
      const chatId = order[next++];
      const rules = rulesByChat.get(chatId);
      if (rules === undefined) {
        unread += 1;
        continue;
      }
      checked += 1;
      if (rules.length === 0) continue;
      // One chat's bad data must not end the run while other workers are still sending (the lock would be
      // released under them): count it and go on.
      try {
        await checkChat(chatId, rules);
      } catch (err) {
        failed += 1;
        console.error('[alerts] chat check failed', err instanceof Error ? err.message : err);
      }
    }
  };
  async function checkChat(chatId: string, rules: AlertRule[]) {

    let changed = false;
    const updated: AlertRule[] = [];

    for (const rule of rules) {
      let nowActive = rule.active;
      let message: string | null = null;
      let failedReads = rule.failedReads ?? 0;
      let breakSent = rule.breakSent;
      let isHeadsUp = false;

      if (rule.type === 'close') {
        nowActive = marketClosed;
        if (nowActive && !rule.active) message = closeDigest;
      } else if (rule.type === 'basis' && rule.symbol && rule.thresholdBp != null) {
        const row = tape.rows.find((r) => r.symbol === rule.symbol);
        nowActive = nextBasisState(rule.active, row?.basisBp != null ? Math.abs(row.basisBp) : null, rule.thresholdBp);
        if (nowActive && !rule.active) {
          message = `${rule.symbol} |basis| crossed ${rule.thresholdBp}bp — now ${bp(row!.basisBp)}.`;
        }
      } else if (rule.type === 'loan' && rule.wallet && rule.thresholdHf != null) {
        const loans = await loansOf(rule.wallet);
        // Capped at the heads-up, so a wallet that stays unreadable doesn't rewrite the chat's rules every tick.
        failedReads = loans == null ? Math.min(failedReads + 1, LOAN_READ_FAIL_NOTICE) : 0;
        // A lender's oracle or the RPC failing for a while would otherwise silence warnings unnoticed.
        // Once, on the step up to the notice (the count then stays there while reads keep failing).
        if (loans == null && failedReads === LOAN_READ_FAIL_NOTICE && (rule.failedReads ?? 0) < LOAN_READ_FAIL_NOTICE) message = loanReadFailText(rule.wallet);
        const worst = loans == null ? null : loans.length === 0 ? 'no-loans' : Math.min(...loans.map(worstHealth));
        nowActive = nextLoanState(rule.active, worst, rule.thresholdHf);
        if (nowActive && !rule.active && loans) {
          const aave = loans.find((l) => l.venue === 'aave');
          message = loanAlertText(rule.wallet, loans, rule.thresholdHf, aave ? rescueLinks(aave, rule.thresholdHf, siteUrl) : null);
        }
        // The weekend or holiday heads-up, once per break, only for a wallet that has a loan and was read; a
        // warning or read notice due on the same tick goes first, and the heads-up follows on the next one.
        if (!message && breakClose && breakSent !== breakClose && loans && loans.length > 0) {
          const aave = loans.find((l) => l.venue === 'aave');
          message = longBreakText(rule.wallet, loans, breakOpenDay, rule.thresholdHf, aave ? rescueLinks(aave, rule.thresholdHf, siteUrl) : null);
          isHeadsUp = true;
        }
      }

      if (message) {
        // A permanent refusal (the bot was blocked, the chat is gone) counts as handled, so it isn't retried
        // every tick forever; only a failure that may pass (network, Telegram 5xx or 429) is retried.
        const delivered = (await sendTelegramMessageStatus(chatId, message)) !== 'retry';
        if (delivered) sent += 1;
        else if (failedReads === LOAN_READ_FAIL_NOTICE) failedReads -= 1; // the heads-up is tried again next tick
        if (isHeadsUp) {
          // Not an edge: the rule's warning state moves as worked out above; only the break is marked, once delivered.
          if (delivered) breakSent = breakClose!;
        } else {
          nowActive = stateAfterSend(rule.active, nowActive, message, delivered);
        }
      }
      if (nowActive !== rule.active || failedReads !== (rule.failedReads ?? 0) || breakSent !== rule.breakSent) changed = true;
      updated.push(rule.type === 'loan' ? { ...rule, active: nowActive, failedReads, ...(breakSent ? { breakSent } : {}) } : { ...rule, active: nowActive });
    }

    if (!changed) return;
    // The batched read is up to the whole run old: re-read the chat and carry only the state this run changed
    // onto its current rules, matched by id, so a /stop or a rule changed meanwhile in the bot isn't undone
    // (review, 2026-11-22). A chat that is now empty stays empty.
    // If that re-read fails, this run's state is saved as it was read, so an alert already sent isn't sent again.
    const fresh = (await getRulesOrNull(chatId)) ?? updated;
    if (fresh.length === 0) return;
    const byId = new Map(updated.map((r) => [r.id, r]));
    await setRules(
      chatId,
      fresh.map((r) => {
        const u = byId.get(r.id);
        if (!u || u.type !== r.type || u.wallet !== r.wallet || u.symbol !== r.symbol) return r;
        return r.type === 'loan' ? { ...r, active: u.active, failedReads: u.failedReads, ...(u.breakSent ? { breakSent: u.breakSent } : {}) } : { ...r, active: u.active };
      }),
    );
  }
  await Promise.all(Array.from({ length: CHAT_CONCURRENCY }, worker));
  const skipped = chatIds.length - checked - unread;
  const summary = { ok: true, chats: chatIds.length, checked, unread, skipped, failed, sent, ms: Date.now() - started };
  // Visible in the function logs: a run that couldn't check every chat must not pass silently.
  (skipped > 0 || unread > 0 || failed > 0 ? console.error : console.log)('[alerts] chats', JSON.stringify(summary));
  return summary;
}
