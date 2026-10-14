import { NextRequest, NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';
import { splitByLiquidity } from '@/lib/liquidity';
import { getAllChatIds, getRules, setRules, nextBasisState, type AlertRule } from '@/lib/alerts';
import { sendTelegramMessage } from '@/lib/telegram';
import { bp } from '@/lib/format';
import { cronAuthorized } from '@/lib/sharedSecret';
import { getWalletLoans } from '@/lib/loanPositions';
import { loanAlertText, nextLoanState, worstHealth, type WalletLoan } from '@/lib/loanHealth';

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

  const marketClosed = tape.session.state !== 'open';
  const { liquid } = splitByLiquidity(tape.rows);
  const closeDigest = `Cash closed. ${liquid.map((r) => `${r.cashTicker} Aero ${bp(r.basisBp)}`).join(' ')}`;

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
        const worst = loans == null ? null : loans.length === 0 ? 'no-loans' : Math.min(...loans.map(worstHealth));
        nowActive = nextLoanState(rule.active, worst, rule.thresholdHf);
        if (nowActive && !rule.active && loans) message = loanAlertText(rule.wallet, loans, rule.thresholdHf);
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
