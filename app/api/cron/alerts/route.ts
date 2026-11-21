import { NextRequest, NextResponse } from 'next/server';
import { getTape, recordTapeSamples } from '@/lib/market/tape';
import { recordDepthSample } from '@/lib/market/depthSamples';
import { splitByLiquidity } from '@/lib/market/liquidity';
import { getAllChatIds, getRules, setRules, nextBasisState, stateAfterSend, type AlertRule } from '@/lib/alerts/alerts';
import { sendTelegramMessageStatus } from '@/lib/alerts/telegram';
import { randomUUID } from 'node:crypto';
import { redis } from '@/lib/server/redis';
import { bp } from '@/lib/format';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { getWalletLoans } from '@/lib/lending/loanPositions';
import { AUTO_PICK_HOLD } from '@/lib/agent/limits';
import { loanAlertText, loanReadFailText, nextLoanState, worstHealth, LOAN_READ_FAIL_NOTICE, type WalletLoan } from '@/lib/lending/loanHealth';
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
  if (redis && (await redis.set(ALERTS_LOCK, lockToken, { nx: true, ex: 55 }).catch(() => 'OK')) == null) {
    return NextResponse.json({ ok: true, skipped: 'another run is sending' });
  }
  try {
    return NextResponse.json(await evaluateRules(tape, marketClosed, closeDigest));
  } finally {
    if (redis) await redis.eval(RELEASE_LOCK, [ALERTS_LOCK], [lockToken]).catch(() => {});
  }
}

const ALERTS_LOCK = 'alerts:lock';
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function evaluateRules(tape: NonNullable<Awaited<ReturnType<typeof getTape>>>, marketClosed: boolean, closeDigest: string) {
  const chatIds = await getAllChatIds();
  let sent = 0;
  // One read per wallet per tick, shared by every chat watching it. null = the read failed: the
  // rule keeps its state (nextLoanState), so a flaky RPC can't fire or re-arm an alert.
  const walletReads = new Map<string, Promise<WalletLoan[] | null>>();
  const loansOf = (wallet: string) => {
    if (!walletReads.has(wallet)) walletReads.set(wallet, getWalletLoans(wallet as `0x${string}`).catch(() => null));
    return walletReads.get(wallet)!;
  };

  for (const chatId of chatIds) {
    const rules = await getRules(chatId);
    if (rules.length === 0) continue;

    let changed = false;
    const updated: AlertRule[] = [];

    for (const rule of rules) {
      let nowActive = rule.active;
      let message: string | null = null;
      let failedReads = rule.failedReads ?? 0;

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
      }

      if (message) {
        // A permanent refusal (the bot was blocked, the chat is gone) counts as handled, so it isn't retried
        // every tick forever; only a failure that may pass (network, Telegram 5xx or 429) is retried.
        const delivered = (await sendTelegramMessageStatus(chatId, message)) !== 'retry';
        if (delivered) sent += 1;
        else if (failedReads === LOAN_READ_FAIL_NOTICE) failedReads -= 1; // the heads-up is tried again next tick
        nowActive = stateAfterSend(rule.active, nowActive, message, delivered);
      }
      if (nowActive !== rule.active || failedReads !== (rule.failedReads ?? 0)) changed = true;
      updated.push(rule.type === 'loan' ? { ...rule, active: nowActive, failedReads } : { ...rule, active: nowActive });
    }

    if (changed) await setRules(chatId, updated);
  }

  return { ok: true, chats: chatIds.length, sent };
}
