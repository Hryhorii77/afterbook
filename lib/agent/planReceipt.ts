// Plan receipts (2026-11-25, step 2 of the pre-Dec 12 plan): what a plan link promised next to what actually
// filled. A fill is a buy signed from this link and verified onchain by the swap log (lib/swap/swapLog.ts: the
// router's own Swapped event for the account, the build Afterbook checked), so the shares received are the chain's,
// not a quote. Pure, for the plan page and the tests. No transaction hash or wallet is shown: a plan link can be
// shared, and a hash leads to the buyer's wallet on any explorer (the same rule as /traction).
import type { PlanLeg } from './plan';
import { savedBuys, type SavedPlan } from './planLink';
import type { SwapRecord } from '../swap/swapLog';

export interface PlanReceipt {
  symbol: string;
  /** When it filled, and how long after the plan was made. */
  at: number;
  afterPlanMs: number;
  /** What the plan said: its amount, the onchain price and cost estimate at the time, and the cost limit. */
  plannedUsd: number | null;
  plannedPriceUsd: number | null;
  plannedCostBp: number | null;
  costLimitBp: number;
  /** What filled. */
  paidUsd: number;
  /** Stock tokens received (the chain's figure), and the price per share they work out to. */
  tokens: number;
  fillPriceUsd: number;
  /** Fill price against the plan's price, in bp (positive: paid more per share than the plan saw). */
  vsPlanPriceBp: number | null;
  /** Shares received against what was quoted when it was signed, in bp (positive: more than quoted). */
  vsQuoteBp: number | null;
  /** Whether it got at least the signed minimum (it can't get less: the swap would revert). */
  metMinimum: boolean | null;
  /** Whether the amount paid stayed within what the plan showed for this stock. */
  withinPlan: boolean | null;
}

const legsOf = (saved: SavedPlan): PlanLeg[] => (saved.kind === 'plan' ? saved.plan.legs : saved.brief.legs);
const raw = (v: string | undefined, decimals: number) => (v && /^\d+$/.test(v) ? Number(BigInt(v)) / 10 ** decimals : null);
const bp = (ratio: number) => Math.round(ratio * 10_000 * 10) / 10;

/** Receipts for the fills of one plan link, oldest first. `decimalsOf` gives a stock token's decimals and
 *  `multiplierOf` its shares per token (the plan's prices are per share, a fill is counted in tokens; 1 when unknown). */
export function planReceipts(
  saved: SavedPlan,
  fills: SwapRecord[],
  decimalsOf: (symbol: string) => number | undefined,
  multiplierOf: (symbol: string) => number | null | undefined = () => 1,
): PlanReceipt[] {
  const legs = new Map(legsOf(saved).map((l) => [l.symbol, l]));
  const planned = savedBuys(saved);
  const costLimitBp = saved.kind === 'plan' ? saved.input.maxCostBp : saved.brief.input.maxCostBp;
  return fills
    // Only stocks the plan listed: anyone with the link could build a swap with its id for another stock, which
    // must not show on its receipts (review, 2026-11-25).
    .filter((f) => f.planId === saved.id && f.side === 'buy' && planned.has(f.symbol))
    .sort((a, b) => a.at - b.at)
    .flatMap((f) => {
      const decimals = decimalsOf(f.symbol);
      const tokens = decimals == null ? null : raw(f.amountOut, decimals);
      if (tokens == null || !(tokens > 0) || !(f.usd > 0)) return [];
      const leg = legs.get(f.symbol);
      const m = multiplierOf(f.symbol);
      const multiplier = m && m > 0 ? m : 1;
      const fillPriceUsd = f.usd / (tokens * multiplier);
      const quoted = raw(f.quotedOut, decimals!);
      const minimum = raw(f.minOut, decimals!);
      const plannedUsd = planned.get(f.symbol) ?? null;
      return [
        {
          symbol: f.symbol,
          at: f.at,
          afterPlanMs: Math.max(0, f.at - saved.at),
          plannedUsd,
          plannedPriceUsd: leg?.priceUsd ?? null,
          plannedCostBp: leg?.costBp ?? null,
          costLimitBp,
          paidUsd: f.usd,
          tokens,
          fillPriceUsd,
          vsPlanPriceBp: leg?.priceUsd ? bp(fillPriceUsd / leg.priceUsd - 1) : null,
          vsQuoteBp: quoted ? bp(tokens / quoted - 1) : null,
          metMinimum: minimum == null ? null : tokens >= minimum,
          // A cent of slack for rounding of the USD figures.
          withinPlan: plannedUsd == null ? null : f.usd <= plannedUsd + 0.01,
        },
      ];
    });
}

/** What the page gets for one receipt (review of #234): display text and pass/fail checks only, worked out on the
 *  server. The exact amounts, tokens, price and times never reach the browser, where they would sit in the page
 *  source and could be searched in the router's events to find the transaction and the buyer. */
export interface ReceiptView {
  symbol: string;
  /** Coarse: "within an hour", "the same day", "N days later". */
  when: string;
  planSaid: string;
  filled: string;
  checks: { label: string; ok: boolean }[];
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctOf = (bp: number) => `${(Math.abs(bp) / 100).toFixed(2)}%`;

export function receiptView(r: PlanReceipt): ReceiptView {
  const hours = r.afterPlanMs / 3_600_000;
  const when = hours < 1 ? 'within an hour of the plan' : hours < 24 ? 'the same day as the plan' : `${Math.round(hours / 24)} days after the plan`;
  const planSaid = [
    r.plannedUsd != null ? `buy up to ${money(r.plannedUsd)}` : 'buy',
    r.plannedPriceUsd != null ? ` at about ${money(r.plannedPriceUsd)} a share` : '',
    r.plannedCostBp != null ? `, cost about ${pctOf(r.plannedCostBp)}` : '',
    ` (limit ${pctOf(r.costLimitBp)})`,
  ].join('');
  // Rounded: whole dollars, tokens to 2 significant figures, the price a share to whole dollars.
  const paid = r.paidUsd >= 1 ? `about $${Math.round(r.paidUsd).toLocaleString('en-US')}` : 'under $1';
  const tokens = Number(r.tokens.toPrecision(2)).toLocaleString('en-US', { maximumFractionDigits: 8 });
  const versus =
    r.vsPlanPriceBp == null ? '' : Math.abs(r.vsPlanPriceBp) < 5 ? ' (about the plan’s price)' : ` (about ${pctOf(Math.round(r.vsPlanPriceBp / 5) * 5)} ${r.vsPlanPriceBp > 0 ? 'above' : 'below'} the plan’s price)`;
  const filled = `${paid} for about ${tokens} ${r.symbol}, about $${Math.round(r.fillPriceUsd).toLocaleString('en-US')} a share${versus}`;
  const checks: ReceiptView['checks'] = [];
  if (r.vsQuoteBp != null) checks.push({ label: r.vsQuoteBp >= 0 ? 'at least what was quoted at signing' : 'a little less than quoted at signing', ok: r.vsQuoteBp >= -50 });
  if (r.metMinimum != null) checks.push({ label: r.metMinimum ? 'at least the signed minimum' : 'below the signed minimum', ok: r.metMinimum });
  if (r.withinPlan != null) checks.push({ label: r.withinPlan ? 'within the plan’s amount' : 'over the plan’s amount', ok: r.withinPlan });
  return { symbol: r.symbol, when, planSaid, filled, checks };
}
