// POST /api/agent/rebalance-check: one due run of a rebalance rule (/rules, lib/agent/rebalance.ts).
// The page reads the wallet's balances of the rule's stocks onchain and sends them with the targets and
// limits (never the address, never the rule); this prices them from the tape, splits the run over the
// stocks below target and runs the trade plan's own checks and sizing (lib/agent/rebalancePlan.ts). No
// Claude call. Read-only: it builds nothing a wallet could sign; the basket is reviewed and signed in the
// normal basket buy.
import { NextResponse } from 'next/server';
import { getTape } from '@/lib/market/tape';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { getStock } from '@/lib/stocks/tokens';
import { swapFee } from '@/lib/swap/swap';
import { getEarningsSyncedAt } from '@/lib/stocks/earningsCalendar';
import { limitRead } from '@/lib/server/readGuard';
import { parsePlanInput, type CostModel } from '@/lib/agent/plan';
import { RULE_LIMITS } from '@/lib/agent/rules';
import { isTargets } from '@/lib/agent/rebalance';
import { planRebalance } from '@/lib/agent/rebalancePlan';
import { countRuleCheckBriefly } from '@/lib/agent/planStats';

export const maxDuration = 30;

// Each pool read gets this long; a slow one counts as unreadable (the stock is left out of this run).
const QUOTE_TIMEOUT_MS = 8_000;
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const RAW_RE = /^\d{1,40}$/;

export async function POST(request: Request) {
  // The rule checks' 10-a-minute bucket: a check is a deliberate click, not a poll.
  const limited = limitRead(request, 'agent-rule', 'lots');
  if (limited) return limited;
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // answered below
  }
  if (!body) return NextResponse.json({ error: 'expected a JSON object' }, { status: 400 });
  const known = (s: string) => !!getStock(s);
  if (!isTargets(body.targets, known)) return NextResponse.json({ error: 'the targets must be 2 to 4 stocks with whole-percent weights that add up to 100' }, { status: 400 });
  const targets = body.targets;
  const budgetUsd = typeof body.usd === 'number' ? body.usd : NaN;
  if (!Number.isFinite(budgetUsd) || budgetUsd < RULE_LIMITS.minRunUsd || budgetUsd > RULE_LIMITS.maxRunUsd) {
    return NextResponse.json({ error: `a run must be between $${RULE_LIMITS.minRunUsd} and $${RULE_LIMITS.maxRunUsd.toLocaleString('en-US')}` }, { status: 400 });
  }
  // The same limits and messages as the plan and single-stock rules.
  const limits = parsePlanInput(
    { symbols: targets.map((t) => t.symbol), budgetUsd, maxPremiumBp: body.maxPremiumBp, maxCostBp: body.maxCostBp, earningsDays: body.earningsDays, note: '' },
    known,
  );
  if (typeof limits === 'string') return NextResponse.json({ error: limits }, { status: 400 });
  const rawBalances = body.balances;
  if (!rawBalances || typeof rawBalances !== 'object' || Array.isArray(rawBalances)) return NextResponse.json({ error: 'the holdings are missing' }, { status: 400 });
  const balances: Record<string, bigint> = {};
  for (const t of targets) {
    const v = (rawBalances as Record<string, unknown>)[t.symbol];
    if (typeof v !== 'string' || !RAW_RE.test(v)) return NextResponse.json({ error: `the holding of ${t.symbol} is missing or not a whole number` }, { status: 400 });
    balances[t.symbol] = BigInt(v);
  }

  try {
    const [tape, earningsSyncedAt] = await Promise.all([getTape(), getEarningsSyncedAt()]);
    const costs = new Map<string, CostModel | null>();
    await Promise.all(
      targets.map(async (t) => {
        const stock = getStock(t.symbol);
        costs.set(t.symbol, stock ? await withTimeout(getBuyQuoter(stock), QUOTE_TIMEOUT_MS).catch(() => null) : null);
      }),
    );
    const plan = planRebalance(
      { targets, budgetUsd, maxPremiumBp: limits.maxPremiumBp, maxCostBp: limits.maxCostBp, earningsDays: limits.earningsDays, balances },
      tape,
      (s) => getStock(s),
      costs,
      earningsSyncedAt,
      swapFee()?.bps ?? 0,
    );
    await countRuleCheckBriefly(!!plan.picks);
    return NextResponse.json({
      plan,
      session: { state: tape.session.state, label: tape.session.label, nextOpenIso: tape.session.nextOpenIso },
      checkedAt: Date.now(),
    });
  } catch (err) {
    console.error('[/api/agent/rebalance-check]', err);
    return NextResponse.json({ error: 'check unavailable, try again shortly' }, { status: 502 });
  }
}
