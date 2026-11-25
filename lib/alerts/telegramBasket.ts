// `/basket [THEME] USD` in the Telegram bot (2026-11-25): the same code-picked basket as /plan's "Describe a basket"
// tab and the MCP make_basket tool (lib/agent/runPlan.ts runBrief, fixed words, never Claude), saved as a plan link
// (via 'telegram') that opens on afterbook.app, where the person connects their own wallet and signs the basket buy
// after the checks run again. The theme is one of the fixed themes (or "tech", the Information Technology sector),
// never free text. The bot itself never asks for a wallet or a signature. Pure parts here; the webhook runs it.
import type { Brief, BriefInput, BriefTheme } from '../agent/brief';
import { SECTORS, type Sector } from '../stocks/sectors';

export const BASKET_USAGE =
  'Usage: /basket [THEME] USD [STOCKS], e.g. "/basket 100", "/basket tech 100" or "/basket chips 250 2" (spread over at least 2 to 4 stocks; 3 if left out). Themes: any, tech, chips, memory, software, internet, consumer, ev, health, china, global, bitcoin, space.';

/** A Telegram word for a theme: the fixed themes' short names, plus "tech" (the Information Technology sector). */
const ALIASES: Record<string, { theme: BriefTheme; only?: Sector }> = {
  any: { theme: 'Any' },
  all: { theme: 'Any' },
  tech: { theme: 'Any', only: 'Information Technology' },
  ai: { theme: 'AI chips' },
  chips: { theme: 'AI chips' },
  memory: { theme: 'Memory & storage' },
  storage: { theme: 'Memory & storage' },
  software: { theme: 'Software & cloud' },
  cloud: { theme: 'Software & cloud' },
  internet: { theme: 'Internet & media' },
  media: { theme: 'Internet & media' },
  consumer: { theme: 'Consumer tech' },
  ev: { theme: 'EVs & autonomy' },
  evs: { theme: 'EVs & autonomy' },
  health: { theme: 'Health care' },
  healthcare: { theme: 'Health care' },
  china: { theme: 'China' },
  global: { theme: 'Outside the US' },
  intl: { theme: 'Outside the US' },
  bitcoin: { theme: 'Bitcoin' },
  btc: { theme: 'Bitcoin' },
  space: { theme: 'Space' },
};
// Every fixed theme reachable by an alias (tests/telegramBasket.test.ts keeps it so).
export const THEME_ALIASES = ALIASES;

/** `/basket` arguments: an optional theme word then a USD budget; or why not. The rest of the brief is the page's defaults. */
export function parseBasketCommand(
  args: string[],
): { theme: BriefTheme; exclude: Sector[]; budgetUsd: number; minStocks?: number; label: string; command: string } | string {
  // A trailing 2, 3 or 4 after the amount is how many stocks to spread over at least (the basket tab's setting).
  let minStocks: number | undefined;
  if (args.length >= 2 && /^[2-4]$/.test(args[args.length - 1]) && /^\$?[\d,]+(\.\d+)?$/.test(args[args.length - 2])) {
    minStocks = Number(args[args.length - 1]);
    args = args.slice(0, -1);
  }
  if (args.length < 1 || args.length > 2) return BASKET_USAGE;
  // "/basket 100 1": a stock count out of range, not a theme (review of #237).
  if (args.length === 2 && /^\$?[\d,]+(\.\d+)?$/.test(args[0]) && /^\d$/.test(args[1])) return `The stock count must be 2, 3 or 4. ${BASKET_USAGE}`;
  const budgetArg = args[args.length - 1].replace(/^\$/, '').replace(/,/g, '');
  const budgetUsd = Number(budgetArg);
  if (!/^\d+(\.\d+)?$/.test(budgetArg) || !Number.isFinite(budgetUsd)) return `The last word should be the amount in USD. ${BASKET_USAGE}`;
  const word = (args.length === 2 ? args[0] : 'any').toLowerCase();
  const alias = ALIASES[word];
  if (!alias) return `Unknown theme "${word.slice(0, 20)}". ${BASKET_USAGE}`;
  const exclude = alias.only ? SECTORS.filter((s) => s !== alias.only) : [];
  const label = alias.only ? 'Information Technology' : alias.theme === 'Any' ? 'any theme' : alias.theme;
  // The command without the stock count, to suggest a retry with fewer stocks.
  const command = `/basket ${args.length === 2 ? word : ''} ${budgetArg}`.replace(/\s+/g, ' ');
  return { theme: alias.theme, exclude, budgetUsd, ...(minStocks ? { minStocks } : {}), label, command };
}

const usd = (n: number) => `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;

/** The bot's reply: the code's picks (weight, amount, cost), what was left out, then the link (or why there is none). */
export function basketReplyText(
  brief: Brief,
  input: Pick<BriefInput, 'maxPremiumBp' | 'maxCostBp' | 'earningsDays' | 'minStocks'>,
  label: string,
  command: string,
  url: string | null,
  linkRefused: boolean,
): string {
  const head = `Basket for ${usd(brief.input.budgetUsd)} (${label}, ${brief.session.label}):`;
  const body: string[] = [];
  if (brief.picks && brief.basket) {
    for (const p of brief.picks) {
      const cut = p.sizedDownBy ? ` (less than an equal share: ${p.sizedDownBy})` : '';
      body.push(`• ${p.symbol}: ${p.weightPct}%, ${usd(p.usd)}, cost about ${pct(p.costBp)}${cut}`);
    }
    if (brief.cashUsd > 0.005) body.push(`Kept as cash: ${usd(brief.cashUsd)}.`);
  } else {
    body.push(brief.shortfall ?? 'No basket passed the checks right now.');
    if (brief.suggestion) body.push(`To spread over ${brief.suggestion.minStocks} instead, send: ${command} ${brief.suggestion.minStocks}`);
  }
  const tail = url
    ? [
        `Open to sign: ${url}`,
        'It opens on afterbook.app (in Base App, use its browser). Connect your wallet there; the checks run again and the basket is offered whole, at most this total, or not at all. Saved for 7 days.',
      ]
    : brief.basket
    ? [linkRefused ? 'No link this time: the daily limit on saved plans was reached. Try again tomorrow.' : 'No link this time. Try again in a minute.']
    : [];
  return [
    head,
    ...body,
    ...tail,
    `Picked by code: the deepest steady pools that pass, equal amounts, ${input.minStocks === 4 ? '4' : `${input.minStocks} to 4`} stocks. Limits: at most ${pct(input.maxPremiumBp)} over the real stock, ${pct(input.maxCostBp)} to trade, and wait within ${input.earningsDays} days of earnings (the /plan page’s defaults; change them there).`,
    'Not available in the US or its territories. Checked by code, not advice.',
  ].join('\n');
}
