// /AGENTS.md and /llms.txt (2026-11-26): the "read me first" pages for AI agents, modelled on base.org/AGENTS.md. Both
// are built here from the code's own lists, never typed by hand: the stocks and pools from lib/stocks/tokens.ts, the
// MCP tools, paid routes and free key from agentDirectory.ts (the same list /agents shows), the Builder Code and the
// plan's limits. The routes app/AGENTS.md and app/llms.txt serve them; scripts/generate-agents-md.mts writes the same
// text to docs/agents/ so the repo shows it (not public/: a file there would be served instead of the routes, without
// their CORS and cache headers), and a test fails when the two drift. Pure: no env, no Redis, no chain read,
// and relative imports only, so the generator runs in plain Node.
import { AERO_CL_FACTORY, CL_FACTORY, STOCKS, USDC } from '../stocks/tokens';
import { BUILDER_CODE } from '../wallet/builderCode';
import { KYBER_ROUTER, MAX_BUY_DEPTH_SHARE, MAX_SWAP_USD } from '../swap/swapConstants';
import { AAVE_MAG7_SPOKE } from '../lending/aaveBorrow';
import { RATE_LIMITS, READ_LIMITS } from '../server/rateLimits';
import { z } from 'zod';
import { AUTO_PICK_HOLD, BRIEF_LIMITS, PLAN_DEFAULTS, PLAN_LIMITS } from './limits';
import { FREE_KEY, MCP_URL, PAID, TOOLS } from './agentDirectory';
import { MCP_EXAMPLES, MCP_INPUTS, type McpToolName } from './mcpTools';

export const SITE = 'https://afterbook.app';
export const REPO = 'https://github.com/Hryhorii77/afterbook';
export const TELEGRAM_BOT = 'https://t.me/afterbook_bot';
export const MCP_REGISTRY_NAME = 'io.github.Hryhorii77/afterbook';
export const GENERATOR = 'scripts/generate-agents-md.mts';

const TAGLINE =
  "Coinbase's tokenized stocks on Base: how far each token trades from the real stock, what a trade would cost in its pool, checked buy plans, and stock-loan health. Agents propose, Afterbook's code checks every number, and a person signs in their own wallet. No agent gets a key, a wallet or a way to sign. Trading is not available in the US or its territories.";

const venue = (factory: string) => (factory === AERO_CL_FACTORY ? 'Aero' : factory === CL_FACTORY ? 'Aerodrome (older factory)' : 'unknown');

/** A contract address with its Basescan link, so an agent can check it. */
export const basescan = (address: string) => `[${address}](https://basescan.org/address/${address})`;
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;
const WINDOW_WORD: Record<number, string> = { 1000: 'second', 60_000: 'minute', 86_400_000: 'day' };
/** "1 a second", "10 a minute", "5 a day". */
const per = (l: { tokens: number; windowMs: number }) => `${l.tokens} a ${WINDOW_WORD[l.windowMs] ?? `${l.windowMs / 1000} s window`}`;
/** The size cap, in words, from the swap code. */
export const SIZE_CAP = `the lower of ${usd(MAX_SWAP_USD)} and ${pct(MAX_BUY_DEPTH_SHARE)} of its pool's live depth`;

type Prop = { type?: string; enum?: string[]; minimum?: number; maximum?: number; exclusiveMinimum?: number; pattern?: string; description?: string; items?: Prop; maxItems?: number };
const isSymbolEnum = (values: string[]) => values.length === STOCKS.length && STOCKS.every((s) => values.includes(s.symbol));
const kind = (p: Prop): string => {
  if (p.enum) return isSymbolEnum(p.enum) ? 'a symbol from the table below' : `one of ${p.enum.map((v) => `"${v}"`).join(', ')}`;
  if (p.type === 'array' && p.items) return `a list${p.maxItems != null ? ` of up to ${p.maxItems}` : ''}, each ${kind(p.items)}`;
  if (p.pattern) return `a ${p.type} matching ${p.pattern}`;
  const max = p.maximum?.toLocaleString('en-US');
  const range =
    p.minimum != null && max != null ? `, ${p.minimum} to ${max}` : p.exclusiveMinimum != null && max != null ? `, more than ${p.exclusiveMinimum}, up to ${max}` : '';
  return `${p.type}${range}`;
};

/** One tool's inputs, from its MCP schema: name, required or optional, type and range or choices, description. */
export function toolInputs(name: McpToolName): string[] {
  const schema = z.toJSONSchema(MCP_INPUTS[name]) as { properties?: Record<string, Prop>; required?: string[] };
  const props = Object.entries(schema.properties ?? {});
  if (!props.length) return ['- No inputs.'];
  return props.map(([key, p]) => `- \`${key}\` (${schema.required?.includes(key) ? 'required' : 'optional'}): ${kind(p)}${p.description ? `. ${p.description}` : ''}`);
}

/** Pages that exist in app/ (a test checks each one has a page file). */
export const SITE_ROUTES: { path: string; what: string }[] = [
  { path: '/', what: 'Trade: the five deepest stocks and one card to swap, borrow or lend' },
  { path: '/markets', what: 'The tape: every tracked stock, its gap, depth and calculators' },
  { path: '/today', what: 'The day’s biggest gap and who reverts at the open' },
  { path: '/[symbol]', what: 'One stock, e.g. /NVDAc (/NVDA redirects); /NVDAc?side=buy&usdc=100#execute fills in a buy' },
  { path: '/stocks', what: 'Every tokenized stock Coinbase lists on Base, tracked or not' },
  { path: '/memes', what: 'Memestocks: meme tokens priced in stock tokens (not stocks)' },
  { path: '/borrow', what: 'Aave and Morpho stock loans, in-app Aave borrowing and lending, look up any wallet’s loans' },
  { path: '/build', what: 'Build a basket of stocks and buy or sell it' },
  { path: '/baskets', what: 'The Basis Tilt basket (new enrollments paused since 2026-11-19)' },
  { path: '/plan', what: 'The trade plan and “Describe a basket”; /plan/<id> is a saved plan link a person signs' },
  { path: '/rules', what: 'Recurring buys and rebalance rules, kept in the browser' },
  { path: '/portfolio', what: 'A wallet’s positions and router approvals; look up any address or Basename' },
  { path: '/agents', what: 'The MCP tools and API routes, with an example' },
  { path: '/traction', what: 'Swaps signed through Afterbook, verified onchain' },
  { path: '/more', what: 'Everything else: baskets, build, memestocks, Telegram, how it works' },
  { path: '/llms.txt', what: 'The short index for agents' },
  { path: '/AGENTS.md', what: 'This file' },
  { path: '/api/mcp', what: 'The MCP server' },
  { path: '/api/v1/*', what: 'The free-key tape and the x402 paid routes' },
];

const held = Object.keys(AUTO_PICK_HOLD);

/** The short index at /llms.txt. */
export function buildLlmsTxt(): string {
  return [
    '# Afterbook',
    '',
    `> ${TAGLINE}`,
    '',
    `Read ${SITE}/AGENTS.md first for the routing rules, every token and pool address, the network and the safety rules.`,
    '',
    '## Free MCP server (no key, no sign-up)',
    '',
    `- Endpoint (streamable HTTP): ${MCP_URL}`,
    `- Claude Code: claude mcp add --transport http afterbook ${MCP_URL}`,
    `- MCP Registry: ${MCP_REGISTRY_NAME}`,
    ...TOOLS.map((t) => `- ${t.name}: ${t.does}`),
    '',
    '## Pay per call over x402 (USDC on Base, no key)',
    '',
    ...PAID.map((r) => `- ${r.route} (${r.price}): ${r.does}`),
    '',
    '## Free API key',
    '',
    `- ${FREE_KEY.issue}`,
    `- ${FREE_KEY.use}`,
    `- ${FREE_KEY.note}`,
    '',
    '## Pages',
    '',
    `- ${SITE}/AGENTS.md: the full map for agents (addresses, routes, rules)`,
    `- ${SITE}/agents: the tools and routes above, with an example`,
    `- ${SITE}/plan: the trade plan and "Describe a basket" for people`,
    `- ${SITE}/markets: the tape of every tracked stock`,
    `- ${TELEGRAM_BOT}: /plan, /basket, gap and loan alerts in Telegram`,
    `- ${REPO}: source and README`,
    '',
    `Generated by ${GENERATOR} from the code; do not edit by hand.`,
    '',
  ].join('\n');
}

/** The long "read me first" at /AGENTS.md. */
export function buildAgentsMd(): string {
  const aero = STOCKS.filter((s) => s.pool.factory === AERO_CL_FACTORY).length;
  const older = STOCKS.length - aero;
  return [
    `<!-- This file is generated by ${GENERATOR}. Do not edit by hand. -->`,
    '',
    '# Afterbook AGENTS.md',
    '',
    `> ${TAGLINE}`,
    '',
    'This is the entry point for AI agents and the models behind them: what Afterbook does, how to route a request, where its MCP server and APIs are, every token and pool address, and the rules that keep people safe. It is built from the code, so it always matches what the site does.',
    '',
    `- Site: ${SITE}`,
    `- Source: ${REPO}`,
    `- For agents: ${SITE}/agents`,
    `- Short index: ${SITE}/llms.txt`,
    `- Telegram bot: ${TELEGRAM_BOT}`,
    '',
    '## What Afterbook does',
    '',
    `- Tracks ${STOCKS.length} of Coinbase's tokenized stocks on Base (B20 tokens, symbols ending in "c", e.g. NVDAc), each against its deepest USDC pool: ${aero} on Aero (formerly Aerodrome) and ${older} on the older Aerodrome factory.`,
    '- For each one: the real stock\'s price, the token\'s onchain mid price in its pool, the gap between them in basis points (100 bp = 1%), and the pool\'s real depth.',
    '- The real stock\'s price is the live regular-session price while the US market is open. When it is shut, it is the latest pre-market or after-hours print if there is one, otherwise the last close; the tape labels which.',
    '- Trade plans and baskets: the code checks and sizes every buy; Claude only explains the finished plan in words. A person opens the plan link and signs each buy in their own wallet.',
    '- Stock loans: Aave and Morpho loans backed by stock tokens, their health now and if the next open matches Base\'s price, and in-app Aave borrowing and USDC lending.',
    '- The Basis Tilt basket: new enrollments are paused since 2026-11-19. Do not tell anyone they can join it.',
    '',
    '## Safety',
    '',
    '- Afterbook is non-custodial. It never holds funds or keys. Agents never sign: every trade, loan and approval is signed by a person in their own wallet, after Afterbook\'s checks.',
    '- A gap is not risk-free arbitrage. While the cash market is shut there is nothing to hedge with, and the gap can widen before it closes.',
    `- The trade plan waits instead of buying when a stock's gap is wider than ${PLAN_LIMITS.maxAbsGapBp / 100}% (${PLAN_LIMITS.maxAbsGapBp} bp) either way: the pool may be stale, or something happened to the stock.`,
    '- The real stock\'s price comes from Yahoo Finance, an unofficial source. Treat it as a reference, not an exchange feed.',
    // Never state the fee's current setting here: this text is fixed at build time and the fee is an env setting.
    '- Afterbook\'s own swap fee is a setting that can change. Read any fee from the live quote the person reviews before signing, not from this file.',
    `- Every transaction Afterbook asks a wallet to sign carries its Builder Code, ${BUILDER_CODE}, so the activity is attributed onchain.`,
    `- Approvals are for the amount of the action (a repay-all adds a small interest buffer) and only for the swap router (KyberSwap, ${basescan(KYBER_ROUTER)}) or the Aave spoke (Aave V4's MAG7 spoke, ${basescan(AAVE_MAG7_SPOKE)}), never unlimited. A request to approve any other spender did not come from Afterbook.`,
    `- A stock buy is capped at ${SIZE_CAP}.`,
    '- A read that fails is reported as a failure, never as "no gap" or "no loans".',
    '- Trading is not available in the US or its territories.',
    '',
    '## Agent routing rules',
    '',
    '- For prices, gaps and depth, use get_tape (MCP), the free-key /api/v1/tape, or the x402 tape. Do not scrape the pages.',
    '- Use the c-suffixed onchain symbols (NVDAc) and the addresses in the table below. Do not guess token addresses: many tokens share the 0xb200… prefix.',
    '- To help someone buy, make a plan (make_plan, make_basket, or the x402 plan and basket routes) or an execute link, and give the person the link. They review it on Afterbook and sign.',
    '- For a stock loan over a weekend or holiday, use check_loan_health; for an Aave loan near its limit, make_rescue_link.',
    `- New listings (${held.join(', ') || 'none right now'}) are left out of automatic picks. Naming one still works, under the same caps.`,
    '- Never present a plan, a gap or a basket as a recommendation or a forecast.',
    '',
    '## Discovery: MCP and APIs',
    '',
    '### MCP server (free, no key)',
    '',
    `- Endpoint (streamable HTTP): ${MCP_URL}`,
    `- MCP Registry: ${MCP_REGISTRY_NAME}`,
    `- Claude Code: \`claude mcp add --transport http afterbook ${MCP_URL}\``,
    '',
    '| Tool | What it does |',
    '| --- | --- |',
    ...TOOLS.map((t) => `| ${t.name} | ${t.does} |`),
    '',
    '### What a plan\'s limits mean',
    '',
    `- Cost limit (maxCostBp): the most one fill may cost, in basis points: the price impact in the pool plus the pool's fee, plus Afterbook's own swap fee if one is set. Default ${PLAN_DEFAULTS.maxCostBp} bp (${PLAN_DEFAULTS.maxCostBp / 100}%), at most ${PLAN_LIMITS.maxCostBp} bp. A buy that would cost more is made smaller or skipped.`,
    `- Size cap: every buy, whatever the budget, is capped at ${SIZE_CAP}.`,
    `- Premium limit (maxPremiumBp): the most the token may trade above the real stock, default ${PLAN_DEFAULTS.maxPremiumBp} bp, at most ${PLAN_LIMITS.maxPremiumBp} bp.`,
    `- Gap stop: a gap wider than ${PLAN_LIMITS.maxAbsGapBp} bp either way waits, whatever the limits above.`,
    `- Earnings (earningsDays): wait if the company reports within this many days, default ${PLAN_DEFAULTS.earningsDays}.`,
    `- Budgets: a plan takes ${usd(PLAN_LIMITS.minBudgetUsd)} to ${usd(PLAN_LIMITS.maxBudgetUsd)}; a basket (one basket buy) ${usd(PLAN_LIMITS.minBudgetUsd)} to ${usd(BRIEF_LIMITS.maxBudgetUsd)}.`,
    '',
    '### Tool inputs and examples',
    '',
    'Each example is the params of an MCP tools/call (name plus arguments), and its arguments pass the tool\'s own schema. The wallet in the loan examples is a public contract, standing in for the borrower\'s address.',
    '',
    ...TOOLS.flatMap((t) => {
      const name = t.name as McpToolName;
      return [`#### ${name}`, '', ...toolInputs(name), '', `Example: \`${JSON.stringify({ name, arguments: MCP_EXAMPLES[name] })}\``, ''];
    }),
    '### Rate limits',
    '',
    '| What | Limit | When it is hit |',
    '| --- | --- | --- |',
    `| MCP make_plan, make_basket | ${per(RATE_LIMITS.mcpPlan)} per caller, one plan call per request; at most ${RATE_LIMITS.planLinkDay.tokens} saved plan links a day site-wide (shared with the Telegram bot) | HTTP 429 with JSON-RPC error -32000 and a Retry-After header in seconds; two plan calls in one batch get 400. Past the daily link cap the plan still answers, with planUrl or buyUrl null. |`,
    `| MCP check_loan_health, make_rescue_link | ${per(READ_LIMITS.lots)} per IP, one loan call per request | HTTP 429 with JSON-RPC error -32000 and Retry-After. |`,
    '| MCP get_tape, get_quote, get_basis_stats | No per-caller limit from Afterbook | - |',
    `| GET /api/v1/tape | ${per(RATE_LIMITS.apiTape)} per key | HTTP 429 with Retry-After. |`,
    `| POST /api/v1/keys | ${per(RATE_LIMITS.apiKeys)} per IP | HTTP 429, no Retry-After: try the next day. |`,
    `| x402 plan, basket, loan-health | ${per(READ_LIMITS.lots)} per IP | HTTP 429 with Retry-After, checked before the payment settles, so a 429 is not charged. |`,
    '| Other x402 routes | None: payment is the limit | - |',
    `| The site's own read routes | ${per(READ_LIMITS.read)} per IP for most, ${per(READ_LIMITS.lots)} for /api/lots and /api/loans, ${per(READ_LIMITS.basename)} for /api/basename | HTTP 429 with Retry-After. |`,
    '',
    '- Limits counted in memory (the MCP loan tools, the x402 plan, basket and loan-health routes, the site\'s read routes) are per server instance, so they are a brake, not an exact count. Wait for Retry-After before trying again.',
    '',
    '### Free HTTP reads',
    '',
    `- ${FREE_KEY.issue}, then ${FREE_KEY.use}. ${FREE_KEY.note}`,
    '- The free-key tape returns, per stock: symbol, cashUsd, midUsd, basisBp, depthUsd, plus the market session. It does not include the close or which kind of price cashUsd is.',
    '- The site\'s own read routes (limits under Rate limits) are for the site\'s pages; agents should prefer MCP or /api/v1.',
    '',
    '### Pay per call over x402 (USDC on Base, no key)',
    '',
    '| Route | Price | What it returns |',
    '| --- | --- | --- |',
    ...PAID.map((r) => `| ${r.route} | ${r.price} | ${r.does} |`),
    '',
    '- An unpaid call returns 402 with the payment terms in the payment-required header (base64). A deploy without x402 configured returns 503.',
    '',
    '## Network reference',
    '',
    '- Base mainnet only. Chain ID 8453.',
    '- RPC: https://mainnet.base.org, then https://base-rpc.publicnode.com',
    '- Explorer: https://basescan.org',
    `- USDC: ${basescan(USDC.address)} (${USDC.decimals} decimals)`,
    `- Aero CL factory: ${basescan(AERO_CL_FACTORY)}`,
    `- Aerodrome CL factory (older): ${basescan(CL_FACTORY)}`,
    `- Swap router (KyberSwap MetaAggregationRouterV2), the only contract a swap calls and the only spender a swap approval names: ${basescan(KYBER_ROUTER)}`,
    `- Aave V4 MAG7 spoke, the only contract an in-app loan or USDC deposit calls and the only spender its approvals name: ${basescan(AAVE_MAG7_SPOKE)}`,
    '',
    `## Tracked stocks and pools (${STOCKS.length})`,
    '',
    'Each stock\'s deepest USDC pool. Addresses are checksummed and come from lib/stocks/tokens.ts.',
    '',
    '| Symbol | Stock | Token | Decimals | USDC pool | Factory |',
    '| --- | --- | --- | --- | --- | --- |',
    ...STOCKS.map((s) => `| ${s.symbol} | ${s.name} (${s.cashTicker}) | ${s.tokenAddress} | ${s.decimals} | ${s.pool.address} | ${venue(s.pool.factory)}, ${s.pool.factory} |`),
    '',
    '## Site routes',
    '',
    ...SITE_ROUTES.map((r) => `- ${r.path}: ${r.what}`),
    '',
    '## Generation',
    '',
    `- Script: ${GENERATOR}`,
    '- Built from: lib/agent/agentsMd.ts',
    '- Output: docs/agents/AGENTS.md and docs/agents/llms.txt (the same text the site serves at /AGENTS.md and /llms.txt)',
    '- Run: npm run generate-agents-md',
    '- Check: npm run generate-agents-md -- --check',
    '',
  ].join('\n');
}
