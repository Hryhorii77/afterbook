// Server-only: turns an untrusted meme-buy request into a SwapRequest for lib/swap.ts, which then builds
// and checks it like any swap. Separate from lib/swap.ts because the swap panel imports that file into
// the browser, and this one reads the meme allowlist (Redis, Dexscreener).
//
// A meme can be bought only if it is on the verified allowlist (lib/memestocks.ts) AND its pool still
// holds at least MEME_MIN_LIQUIDITY_USD right now. It is paid with USDC or the stock token its pool is
// priced in, never anything else, and never sold here (the panel is buy-only).
import { getMemeRow, MEME_MIN_LIQUIDITY_USD } from './memestocks';
import { getStock } from './tokens';
import type { SwapRequest } from './swap';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^[0-9]{1,30}$/;

export async function parseMemeSwapRequest(input: { meme?: unknown; payWith?: unknown; amountIn?: unknown }): Promise<SwapRequest | string> {
  if (typeof input.meme !== 'string' || !ADDRESS_RE.test(input.meme)) return 'meme must be a token address';
  if (typeof input.amountIn !== 'string' || !AMOUNT_RE.test(input.amountIn)) return 'amountIn must be a raw integer string';
  const amountIn = BigInt(input.amountIn);
  if (amountIn <= BigInt(0)) return 'amountIn must be above zero';

  const row = await getMemeRow(input.meme);
  if (!row) return 'this meme is not on the verified list';
  if ((row.liquidityUsd ?? 0) < MEME_MIN_LIQUIDITY_USD) return 'this meme is under the liquidity floor for buying';
  const stock = getStock(row.pool.stockSymbol);
  if (!stock) return 'this meme is not on the verified list';

  // Pay with USDC, or with the stock token the meme's own pool is priced in (by its symbol).
  const payWith = input.payWith === 'USDC' ? 'USDC' : input.payWith === stock.symbol ? 'stock' : null;
  if (!payWith) return `pay with USDC or ${stock.symbol}`;
  return { stock, side: 'buy', amountIn, meme: { pool: row.pool, payWith } };
}
