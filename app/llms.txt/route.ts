// /llms.txt (2026-11-25): a plain-text map of Afterbook for agents and the models behind them, from the same list as
// /agents (lib/agent/agentDirectory.ts), so the two can't disagree. Static text: no Redis, no chain read.
import { FREE_KEY, MCP_URL, PAID, TOOLS } from '@/lib/agent/agentDirectory';

export const dynamic = 'force-static';

export function GET() {
  const text = [
    '# Afterbook',
    '',
    "> Coinbase's tokenized stocks on Base: how far each token trades from the real stock, what a trade would cost in its pool, checked buy plans, and stock-loan health. Agents propose, Afterbook's code checks every number, and a person signs in their own wallet. No agent gets a key, a wallet or a way to sign. Trading is not available in the US or its territories.",
    '',
    '## Free MCP server (no key, no sign-up)',
    '',
    `- Endpoint (streamable HTTP): ${MCP_URL}`,
    `- Claude Code: claude mcp add --transport http afterbook ${MCP_URL}`,
    '- MCP Registry: io.github.Hryhorii77/afterbook',
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
    '- https://afterbook.app/agents: the tools and routes above, with an example',
    '- https://afterbook.app/plan: the trade plan and "Describe a basket" for people',
    '- https://afterbook.app/markets: the tape of every tracked stock',
    '- https://t.me/afterbook_bot: /plan, /basket, gap and loan alerts in Telegram',
    '- https://github.com/Hryhorii77/afterbook: source and README',
    '',
  ].join('\n');
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
