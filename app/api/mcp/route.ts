import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { getTape } from '@/lib/market/tape';
import { toPublicTape } from '@/lib/market/publicTape';
import { getStock, STOCKS } from '@/lib/stocks/tokens';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { getClosedPeriodStats } from '@/lib/market/history';
import { parsePlanInput } from '@/lib/agent/plan';
import { parseBriefInput } from '@/lib/agent/brief';
import { runPlan, runBrief } from '@/lib/agent/runPlan';
import { saveStockPlan, saveBasket } from '@/lib/agent/savedPlan';
import { planLinkPath } from '@/lib/agent/planLink';
import { siteUrl } from '@/lib/share/siteUrl';
import { SECTORS, THEMES } from '@/lib/stocks/sectors';
import { limitRead } from '@/lib/server/readGuard';

const HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

export const revalidate = 0;
export const maxDuration = 60;

const SYMBOLS = STOCKS.map((s) => s.symbol) as [string, ...string[]];

const handler = createMcpHandler((server) => {
  server.registerTool(
    'get_tape',
    {
      title: 'Get Tape',
      description:
        "Cash-market close price vs the on-chain price on Aero (formerly Aerodrome) for the Coinbase tokenized stocks Afterbook tracks on Base — basis in bp and real pool depth. Read-only; no wallet is ever involved.",
      inputSchema: z.object({}),
    },
    async () => {
      const tape = await getTape();
      return { content: [{ type: 'text', text: JSON.stringify(toPublicTape(tape)) }] };
    },
  );

  server.registerTool(
    'get_quote',
    {
      title: 'Get Quote',
      description:
        'Estimate shares out, execution price, and price impact for sizing a USDC -> stock trade on one of the tracked pools. This is a local estimate for sizing a trade, not a firm quote — the actual fill happens on chain, through the swap on afterbook.app, signed in the trader\'s own wallet (make_plan returns a link that opens it filled in); this tool signs nothing.',
      inputSchema: z.object({
        symbol: z.enum(SYMBOLS),
        usdcIn: z.number().positive().max(10_000_000),
      }),
    },
    async ({ symbol, usdcIn }) => {
      const stock = getStock(symbol);
      if (!stock) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown symbol' }) }], isError: true };
      }
      const quoter = await getBuyQuoter(stock);
      const estimate = quoter.estimate(usdcIn);
      const curve = quoter.curve();
      return { content: [{ type: 'text', text: JSON.stringify({ symbol: stock.symbol, ...estimate, curve }) }] };
    },
  );

  server.registerTool(
    'get_basis_stats',
    {
      title: 'Get Basis Stats',
      description:
        'How big the basis typically gets while the cash market is NOT open, over the last 30 days — mean, mean absolute, and max absolute basis in bp, sampled every 5 minutes off real traffic. Returns null if there is not enough sampled history yet.',
      inputSchema: z.object({
        symbol: z.enum(SYMBOLS),
      }),
    },
    async ({ symbol }) => {
      const stats = await getClosedPeriodStats(symbol, Date.now() - HISTORY_LOOKBACK_MS);
      return { content: [{ type: 'text', text: JSON.stringify({ symbol, stats }) }] };
    },
  );

  // The plan tools (2026-11-21): the same code as /plan and the paid x402 routes (lib/agent/runPlan.ts),
  // explained in fixed words (no Claude call, so a free tool can't run up the bill; the x402 routes add
  // Claude's explanation). Read-only: each returns a link where a person opens the plan on afterbook.app
  // and signs its buys after the checks run again. Rate-limited per caller in POST below.
  const err = (error: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], isError: true });
  // The MCP request has no request of its own here; the explanation gate is skipped, so this is never read.
  const noRequest = new Request(siteUrl);

  server.registerTool(
    'make_plan',
    {
      title: 'Make a trade plan',
      description:
        'A checked trade plan for Coinbase tokenized stocks on Base: for each stock a buy, wait or skip verdict with reasons (gap to the real stock, stale pool, earnings, depth) and a size within your cost limit, $25k and 10% of the pool. Returns planUrl, a link where a person opens the plan on afterbook.app and signs each buy in their own wallet, after the checks run again and never for more than the plan shows. Reads only; signs nothing.',
      inputSchema: z.object({
        symbols: z.array(z.enum(SYMBOLS)).max(8).optional().describe('Stocks to check; none = the deepest pools.'),
        budgetUsd: z.number().positive(),
        maxPremiumBp: z.number().optional().describe('Most the token may trade above the cash price, in bp (default 50).'),
        maxCostBp: z.number().optional().describe('Most a fill may cost, price impact plus pool fee, in bp (default 30).'),
        earningsDays: z.number().int().optional().describe('Wait if earnings are within this many days: 0, 2 or 7 (default 2).'),
      }),
    },
    async (args) => {
      const input = parsePlanInput({ ...args, symbols: args.symbols ?? [] }, (sym) => !!getStock(sym));
      if (typeof input === 'string') return err(input);
      try {
        const out = await runPlan(input, noRequest, { explain: false });
        const id = await saveStockPlan(input, out, 'mcp');
        return { content: [{ type: 'text', text: JSON.stringify({ ...out, planUrl: id ? `${siteUrl}${planLinkPath(id)}` : null }) }] };
      } catch (e) {
        console.error('[/api/mcp make_plan]', e);
        return err('plan unavailable, try again shortly');
      }
    },
  );

  server.registerTool(
    'make_basket',
    {
      title: 'Make a basket',
      description:
        'A 2-4 stock basket of Coinbase tokenized stocks on Base from a theme or sectors: the code picks the deepest steady pools that pass the checks and sizes them within your budget and cost limit, with every dropped stock and why. Returns buyUrl, a link where a person opens the basket on afterbook.app and signs its buy in their own wallet, after the checks run again and never for more than the basket shows. Reads only; signs nothing.',
      inputSchema: z.object({
        theme: z.enum(['Any', ...THEMES]).optional().describe('One of Afterbook\'s fixed themes (default: Any).'),
        exclude: z.array(z.enum(SECTORS)).optional().describe('GICS sectors to leave out.'),
        minStocks: z.number().int().optional(),
        budgetUsd: z.number().positive(),
        cashPct: z.number().optional(),
        maxPremiumBp: z.number().optional(),
        maxCostBp: z.number().optional(),
        earningsDays: z.number().int().optional(),
      }),
    },
    async (args) => {
      const input = parseBriefInput({ ...args, exclude: args.exclude ?? [] });
      if (typeof input === 'string') return err(input);
      try {
        const out = await runBrief(input, noRequest, { explain: false });
        const id = await saveBasket(out, 'mcp');
        return { content: [{ type: 'text', text: JSON.stringify({ ...out, buyUrl: id ? `${siteUrl}${planLinkPath(id)}` : null }) }] };
      } catch (e) {
        console.error('[/api/mcp make_basket]', e);
        return err('basket unavailable, try again shortly');
      }
    },
  );
});

/** The plan tools read pools and save a link: held to the same 10 a minute per caller as the plan routes,
 *  one token per plan call (a JSON-RPC batch of several plan calls takes one each). */
const PLAN_TOOLS = new Set(['make_plan', 'make_basket']);
async function POST(request: Request) {
  const body: unknown = await request.clone().json().catch(() => null);
  const calls = Array.isArray(body) ? body : [body];
  const planCalls = calls.filter((c) => {
    const m = c as { method?: unknown; params?: { name?: unknown } } | null;
    return m?.method === 'tools/call' && typeof m.params?.name === 'string' && PLAN_TOOLS.has(m.params.name);
  }).length;
  for (let i = 0; i < planCalls; i++) {
    const limited = limitRead(request, 'agent-plan', 'lots');
    if (limited) return limited;
  }
  return handler(request);
}

export { handler as GET, POST };
