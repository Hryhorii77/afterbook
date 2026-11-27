import { createMcpHandler } from 'mcp-handler';
import { MCP_INPUTS } from '@/lib/agent/mcpTools';
import { getTape } from '@/lib/market/tape';
import { toPublicTape } from '@/lib/market/publicTape';
import { getStock } from '@/lib/stocks/tokens';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { getClosedPeriodStats } from '@/lib/market/history';
import { parsePlanInput } from '@/lib/agent/plan';
import { parseBriefInput } from '@/lib/agent/brief';
import { runPlan, runBrief } from '@/lib/agent/runPlan';
import { saveStockPlan, saveBasket } from '@/lib/agent/savedPlan';
import { hasLinkableBuy, planLinkPath } from '@/lib/agent/planLink';
import { siteUrl } from '@/lib/share/siteUrl';
import { limitRead } from '@/lib/server/readGuard';
import { mcpPlanLimiter, planLinkDailyLimiter } from '@/lib/server/ratelimit';
import { callerIp } from '@/lib/agent/explainGate';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';
import { loanHealthReport } from '@/lib/lending/loanReport';
import { DEFAULT_ALERT_HEALTH, healthAtAero } from '@/lib/lending/loanHealth';
import { getWalletLoans } from '@/lib/lending/loanPositions';
import { rescueLinks, rescueScenario } from '@/lib/lending/rescueLink';

const HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

export const revalidate = 0;
export const maxDuration = 60;

const handler = createMcpHandler((server) => {
  server.registerTool(
    'get_tape',
    {
      title: 'Get Tape',
      description:
        "Cash-market close price vs the on-chain price on Aero (formerly Aerodrome) for the Coinbase tokenized stocks Afterbook tracks on Base — basis in bp and real pool depth. Read-only; no wallet is ever involved.",
      inputSchema: MCP_INPUTS.get_tape,
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
      inputSchema: MCP_INPUTS.get_quote,
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
      inputSchema: MCP_INPUTS.get_basis_stats,
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
  // The site-wide daily ceiling on links saved by these free tools; past it the plan answers without one.
  const linkAllowed = async () => !planLinkDailyLimiter || (await planLinkDailyLimiter.limit('all')).success;
  const err = (error: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error }) }], isError: true });
  // The MCP request has no request of its own here; the explanation gate is skipped, so this is never read.
  const noRequest = new Request(siteUrl);

  server.registerTool(
    'make_plan',
    {
      title: 'Make a trade plan',
      description:
        'A checked trade plan for Coinbase tokenized stocks on Base: for each stock a buy, wait or skip verdict with reasons (gap to the real stock, stale pool, earnings, depth) and a size within your cost limit, $25k and 10% of the pool. Returns planUrl, a link where a person opens the plan on afterbook.app and signs each buy in their own wallet, after the checks run again and never for more than the plan shows. Reads only; signs nothing.',
      inputSchema: MCP_INPUTS.make_plan,
    },
    async (args) => {
      const input = parsePlanInput({ ...args, symbols: args.symbols ?? [] }, (sym) => !!getStock(sym));
      if (typeof input === 'string') return err(input);
      try {
        const out = await runPlan(input, noRequest, { explain: false });
        // Only a plan with a buy is saved, so only that one counts toward the daily cap.
        const hasBuy = hasLinkableBuy(out.plan);
        const id = hasBuy && (await linkAllowed()) ? await saveStockPlan(input, out, 'mcp') : null;
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
      inputSchema: MCP_INPUTS.make_basket,
    },
    async (args) => {
      const input = parseBriefInput({ ...args, exclude: args.exclude ?? [] });
      if (typeof input === 'string') return err(input);
      try {
        const out = await runBrief(input, noRequest, { explain: false });
        const id = out.brief.basket && (await linkAllowed()) ? await saveBasket(out, 'mcp') : null;
        return { content: [{ type: 'text', text: JSON.stringify({ ...out, buyUrl: id ? `${siteUrl}${planLinkPath(id)}` : null }) }] };
      } catch (e) {
        console.error('[/api/mcp make_basket]', e);
        return err('basket unavailable, try again shortly');
      }
    },
  );
  // Free read of a wallet's stock loans (2026-11-22): the same answer as the paid /api/v1/x402/loan-health
  // (lib/lending/loanReport.ts), including the health if the next open matches Base's price. Read-only; held to
  // one call per request and the read routes' per-caller limit in POST below.
  server.registerTool(
    'check_loan_health',
    {
      title: 'Check loan health',
      description:
        "A wallet's Aave V4 and Morpho stock-token loans on Base: health at the lending oracle and at Aero's onchain price, which keeps trading while the cash market is shut (healthIfNextOpenAtBase: the loan's health if the next open matches Base's price, e.g. over a weekend), how far the collateral could fall before liquidation, whether it is under the threshold, and for an Aave loan links that open Afterbook's Aave panel with the repay or the added collateral worked out from the connected wallet's own loan, for the person to check and sign. Reads public positions only; signs nothing.",
      inputSchema: MCP_INPUTS.check_loan_health,
    },
    async ({ wallet, threshold }) => {
      try {
        const report = await loanHealthReport(getAddress(wallet.toLowerCase()), threshold ?? DEFAULT_ALERT_HEALTH);
        return { content: [{ type: 'text', text: JSON.stringify(report) }] };
      } catch (e) {
        console.error('[/api/mcp check_loan_health]', e);
        return err('loan health unavailable, try again shortly');
      }
    },
  );
  // A rescue link for agents (2026-11-22): the loan warning's own link to the Aave panel (lib/lending/rescueLink.ts),
  // preset from the wallet's loan read now. The link carries only the planner's fall and target and which field to
  // fill, never an amount or a wallet: the panel works the amount out from whichever wallet connects, and the person
  // checks it and signs. Same limits as check_loan_health.
  server.registerTool(
    'make_rescue_link',
    {
      title: 'Make a loan rescue link',
      description:
        "For a wallet's Aave V4 stock loan on Base: a link that opens Afterbook's Aave panel with its rescue planner set to repay USDC or add collateral, at the price fall implied by Base's price now and a target health above your threshold. The link carries no amount and no wallet: the panel fills the Repay or Add field from the loan of the wallet the person connects, and they check it and sign. Returns null url with a reason for a wallet with no Aave loan (Morpho loans have no in-app panel). Reads public positions only; signs nothing.",
      inputSchema: MCP_INPUTS.make_rescue_link,
    },
    async ({ wallet, action, threshold }) => {
      try {
        const line = threshold ?? DEFAULT_ALERT_HEALTH;
        const loans = await getWalletLoans(getAddress(wallet.toLowerCase()));
        const aave = loans.find((l) => l.venue === 'aave');
        if (!aave) {
          const reason = loans.length ? 'only Morpho loans, which have no in-app panel' : 'no Aave stock loan on Base';
          return { content: [{ type: 'text', text: JSON.stringify({ url: null, reason }) }] };
        }
        const links = rescueLinks(aave, line, siteUrl)!;
        const round = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                url: action === 'repay' ? links.repayUrl : links.addUrl,
                scenario: rescueScenario(aave, line),
                healthFactor: round(aave.healthFactor),
                healthAtAero: round(healthAtAero(aave)),
                note: 'The person opens this, connects the borrowing wallet and ticks the eligibility box; the panel works out and fills the amount, and they check it and sign. Nothing is filled if that wallet holds no USDC (repay) or none of the stocks (add). Not advice.',
              }),
            },
          ],
        };
      } catch (e) {
        console.error('[/api/mcp make_rescue_link]', e);
        return err('loan unavailable, try again shortly');
      }
    },
  );
  // How the server names itself to clients (it said "mcp-typescript server on vercel" before, 2026-11-25).
}, { serverInfo: { name: 'afterbook', version: '1.0.0' } });

/** The plan tools read pools and save a link. One plan call per request (a JSON-RPC batch with more is
 *  refused before anything is counted), held to the plan routes' 10 a minute per caller in this
 *  instance and, across instances, to `mcpPlanLimiter` (Upstash). */
const PLAN_TOOLS = new Set(['make_plan', 'make_basket']);
const LOAN_TOOLS = new Set(['check_loan_health', 'make_rescue_link']);
const rpcError = (status: number, message: string, headers?: HeadersInit) =>
  NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }, { status, headers });
async function POST(request: Request) {
  const body: unknown = await request.clone().json().catch(() => null);
  const calls = Array.isArray(body) ? body : [body];
  const named = (set: Set<string>) =>
    calls.filter((c) => {
      const m = c as { method?: unknown; params?: { name?: unknown } } | null;
      return m?.method === 'tools/call' && typeof m.params?.name === 'string' && set.has(m.params.name);
    }).length;
  const planCalls = named(PLAN_TOOLS);
  const loanCalls = named(LOAN_TOOLS);
  if (planCalls > 1) return rpcError(400, 'one make_plan or make_basket call per request');
  if (loanCalls > 1) return rpcError(400, 'one check_loan_health or make_rescue_link call per request');
  if (loanCalls === 1) {
    // Several chain reads, no Redis: the read routes' in-memory per-caller limit.
    const limited = limitRead(request, 'mcp-loan-health', 'lots');
    if (limited) return rpcError(429, 'too many requests, try again shortly', { 'Retry-After': limited.headers.get('Retry-After') ?? '60' });
  }
  if (planCalls === 1) {
    const limited = limitRead(request, 'agent-plan', 'lots');
    if (limited) return rpcError(429, 'too many requests, try again shortly', { 'Retry-After': limited.headers.get('Retry-After') ?? '60' });
    // No Redis (local): the in-memory count above is the only one.
    if (mcpPlanLimiter && !(await mcpPlanLimiter.limit(callerIp(request))).success) {
      return rpcError(429, 'too many requests, try again shortly', { 'Retry-After': '60' });
    }
  }
  return handler(request);
}

export { handler as GET, POST };
