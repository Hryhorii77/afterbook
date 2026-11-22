// `/plan STOCK… USD` in the Telegram bot (2026-11-22): the same checked plan as /plan and the MCP make_plan tool
// (lib/agent/runPlan.ts, fixed words, never Claude), saved as a plan link (via 'telegram') that opens on
// afterbook.app, where the person connects their own wallet and signs each buy after the checks run again. The bot
// itself never asks for a wallet or a signature. Pure parts here; the webhook runs the plan and saves the link.
import type { Plan, PlanInput } from '../agent/plan';
import { AUTO_PICK_HOLD } from '../agent/limits';

export const TELEGRAM_PLAN_MAX_SYMBOLS = 4;
export const PLAN_USAGE = 'Usage: /plan STOCK [STOCK…] USD, e.g. "/plan NVDA 100" or "/plan NVDA AAPL 250" (up to 4 stocks).';

/** `/plan` arguments: stock names (resolved by `find`, e.g. NVDA or NVDAc) then a USD budget; or why not. */
export function parsePlanCommand(args: string[], find: (s: string) => string | undefined): { symbols: string[]; budgetUsd: number } | string {
  if (args.length < 2) return PLAN_USAGE;
  const budgetArg = args[args.length - 1].replace(/^\$/, '').replace(/,/g, '');
  const budgetUsd = Number(budgetArg);
  if (!/^\d+(\.\d+)?$/.test(budgetArg) || !Number.isFinite(budgetUsd)) return `The last word should be the amount in USD. ${PLAN_USAGE}`;
  const names = args.slice(0, -1);
  if (names.length > TELEGRAM_PLAN_MAX_SYMBOLS) return `Up to ${TELEGRAM_PLAN_MAX_SYMBOLS} stocks per plan here.`;
  const symbols: string[] = [];
  for (const n of names) {
    const sym = find(n);
    if (!sym) return `Unknown stock "${n.slice(0, 20)}".`;
    if (!symbols.includes(sym)) symbols.push(sym);
  }
  return { symbols, budgetUsd };
}

const usd = (n: number) => `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;

/** The bot's reply: one line per stock from the code's own verdicts and numbers, then the link (or why there is none). */
export function planReplyText(plan: Plan, input: Pick<PlanInput, 'maxPremiumBp' | 'maxCostBp' | 'earningsDays'>, url: string | null, linkRefused: boolean): string {
  const lines = plan.legs.map((l) => {
    if (l.verdict === 'buy' && l.usd != null) {
      const cost = l.costBp != null ? `, cost about ${pct(l.costBp)}` : '';
      const cut = l.cutBy ? ` (less than an equal share: ${l.cutBy})` : '';
      // A new listing is never offered from a plan link (AUTO_PICK_HOLD): say so rather than imply the link has it.
      const held = AUTO_PICK_HOLD[l.symbol] ? ' (new listing: not offered from a link; buy it on its own page on afterbook.app)' : '';
      return `• ${l.symbol}: buy ${usd(l.usd)}${cost}${cut}${held}`;
    }
    return `• ${l.symbol}: ${l.verdict}. ${l.decidedBy ?? l.reasons[0] ?? ''}`.trimEnd();
  });
  const tail = url
    ? [
        `Open to sign: ${url}`,
        'It opens on afterbook.app (in Base App, use its browser). Connect your wallet there; the checks run again and each buy it offers is at most what this plan shows. Saved for 7 days.',
      ]
    : [linkRefused ? 'No link this time: the daily limit on saved plans was reached. Try again tomorrow.' : 'Nothing a link can offer now, so no link.'];
  return [
    `Plan for ${usd(plan.budgetUsd)} (${plan.session.label}):`,
    ...lines,
    ...tail,
    `Limits used: at most ${pct(input.maxPremiumBp)} over the real stock, ${pct(input.maxCostBp)} to trade, and wait within ${input.earningsDays} days of earnings (the /plan page’s defaults; change them there).`,
    'Not available in the US or its territories. Checked by code, not advice.',
  ].join('\n');
}
