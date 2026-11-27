// The MCP tools' inputs (2026-11-27), apart from app/api/mcp/route.ts so /AGENTS.md (lib/agent/agentsMd.ts) can show
// each tool's real parameters and an example call that the same schema accepts (tests/agentsMd.test.ts parses every
// example). The route registers its tools with these schemas, so the file and the server can't disagree.
// Pure: zod and constants only, no Next, Redis or chain read.
import { z } from 'zod';
import { STOCKS } from '../stocks/tokens';
import { SECTORS, THEMES } from '../stocks/sectors';
import { DEFAULT_ALERT_HEALTH, MAX_ALERT_HEALTH, MIN_ALERT_HEALTH } from '../lending/loanHealth';
import { BRIEF_DEFAULTS, BRIEF_LIMITS, PLAN_DEFAULTS, PLAN_LIMITS } from './limits';

const SYMBOLS = STOCKS.map((s) => s.symbol) as [string, ...string[]];
const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
const wallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('The borrower address.');
const premium = z.number().min(0).max(PLAN_LIMITS.maxPremiumBp).optional();
const cost = z.number().min(1).max(PLAN_LIMITS.maxCostBp).optional();
const earnings = z.number().int().min(0).max(PLAN_LIMITS.maxEarningsDays).optional();
const threshold = z.number().min(MIN_ALERT_HEALTH).max(MAX_ALERT_HEALTH).optional();

export const MCP_INPUTS = {
  get_tape: z.object({}),
  get_quote: z.object({
    symbol: z.enum(SYMBOLS),
    usdcIn: z.number().positive().max(10_000_000),
  }),
  get_basis_stats: z.object({
    symbol: z.enum(SYMBOLS),
  }),
  make_plan: z.object({
    symbols: z.array(z.enum(SYMBOLS)).max(PLAN_LIMITS.maxSymbols).optional().describe('Stocks to check; none = the deepest pools.'),
    budgetUsd: z.number().min(PLAN_LIMITS.minBudgetUsd).max(PLAN_LIMITS.maxBudgetUsd).describe(`USDC to plan, ${usd(PLAN_LIMITS.minBudgetUsd)} to ${usd(PLAN_LIMITS.maxBudgetUsd)}; each buy is still capped at $25,000 and 10% of its pool.`),
    maxPremiumBp: premium.describe(`Most the token may trade above the cash price, in bp, 0 to ${PLAN_LIMITS.maxPremiumBp} (default ${PLAN_DEFAULTS.maxPremiumBp}).`),
    maxCostBp: cost.describe(`Most a fill may cost, price impact plus pool fee, in bp, 1 to ${PLAN_LIMITS.maxCostBp} (default ${PLAN_DEFAULTS.maxCostBp}).`),
    earningsDays: earnings.describe(`Wait if earnings are within this many days, 0 to ${PLAN_LIMITS.maxEarningsDays} (default ${PLAN_DEFAULTS.earningsDays}).`),
  }),
  make_basket: z.object({
    theme: z.enum(['Any', ...THEMES]).optional().describe('One of Afterbook\'s fixed themes (default: Any).'),
    exclude: z.array(z.enum(SECTORS)).optional().describe('GICS sectors to leave out.'),
    minStocks: z.number().int().min(BRIEF_LIMITS.minStocks).max(BRIEF_LIMITS.maxStocks).optional().describe(`Spread over at least this many stocks, ${BRIEF_LIMITS.minStocks} to ${BRIEF_LIMITS.maxStocks} (default ${BRIEF_DEFAULTS.minStocks}).`),
    budgetUsd: z.number().min(PLAN_LIMITS.minBudgetUsd).max(BRIEF_LIMITS.maxBudgetUsd).describe(`USDC for the basket, ${usd(PLAN_LIMITS.minBudgetUsd)} to ${usd(BRIEF_LIMITS.maxBudgetUsd)} (one basket buy).`),
    cashPct: z.number().min(0).max(BRIEF_LIMITS.maxCashPct).optional().describe(`Percent of the budget to keep as cash, 0 to ${BRIEF_LIMITS.maxCashPct} (default ${BRIEF_DEFAULTS.cashPct}).`),
    maxPremiumBp: premium.describe(`Most a token may trade above the cash price, in bp, 0 to ${PLAN_LIMITS.maxPremiumBp} (default ${PLAN_DEFAULTS.maxPremiumBp}).`),
    maxCostBp: cost.describe(`Most a fill may cost, price impact plus pool fee, in bp, 1 to ${PLAN_LIMITS.maxCostBp} (default ${PLAN_DEFAULTS.maxCostBp}).`),
    earningsDays: earnings.describe(`Wait if earnings are within this many days, 0 to ${PLAN_LIMITS.maxEarningsDays} (default ${PLAN_DEFAULTS.earningsDays}).`),
  }),
  check_loan_health: z.object({
    wallet,
    threshold: threshold.describe(`Health to flag loans under (default ${DEFAULT_ALERT_HEALTH}).`),
  }),
  make_rescue_link: z.object({
    wallet,
    action: z.enum(['repay', 'add']).describe('repay = pay back USDC; add = post more of a stock already in the wallet as collateral.'),
    threshold: threshold.describe(`The health line to get back above (default ${DEFAULT_ALERT_HEALTH}).`),
  }),
} as const;

export type McpToolName = keyof typeof MCP_INPUTS;

/** One example call per tool, as the `arguments` of an MCP tools/call. Each must parse with its tool's schema
 *  (tested). The wallet is Aave's Equities Hub, a public contract address, as a placeholder. */
const EXAMPLE_WALLET = '0xa4d5947Eb727A052bae69C593FfC84247EC9864E';
export const MCP_EXAMPLES: Record<McpToolName, Record<string, unknown>> = {
  get_tape: {},
  get_quote: { symbol: 'NVDAc', usdcIn: 500 },
  get_basis_stats: { symbol: 'NVDAc' },
  make_plan: { symbols: ['NVDAc', 'AAPLc'], budgetUsd: 200 },
  make_basket: { theme: 'Any', budgetUsd: 300, minStocks: 3 },
  check_loan_health: { wallet: EXAMPLE_WALLET },
  make_rescue_link: { wallet: EXAMPLE_WALLET, action: 'repay' },
};
