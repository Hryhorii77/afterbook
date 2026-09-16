import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { getTape } from '@/lib/tape';
import { toPublicTape } from '@/lib/publicTape';
import { getStock, STOCKS } from '@/lib/tokens';
import { buildImpactCurve, estimateLot, getCachedPoolState } from '@/lib/quote';

export const revalidate = 0;

const SYMBOLS = STOCKS.map((s) => s.symbol) as [string, ...string[]];

const handler = createMcpHandler((server) => {
  server.registerTool(
    'get_tape',
    {
      title: 'Get Tape',
      description:
        "Cash-market close price vs Aerodrome's on-chain price for Coinbase's ten tokenized stocks on Base — basis in bp and real pool depth. Read-only; no wallet is ever involved.",
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
        'Estimate shares out, execution price, and price impact for sizing a USDC -> stock trade on one of the ten pools. This is a local estimate for sizing a trade, not a firm quote — the actual fill always happens on Aerodrome\'s own app, and no wallet ever signs anything here.',
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
      const state = await getCachedPoolState(stock);
      const estimate = estimateLot(state, stock, usdcIn);
      const curve = buildImpactCurve(state, stock);
      return { content: [{ type: 'text', text: JSON.stringify({ symbol: stock.symbol, ...estimate, curve }) }] };
    },
  );
});

export { handler as GET, handler as POST };
