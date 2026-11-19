// The browser's own floor under every swap it is asked to sign (2026-11-19, from the owner's review of
// #191). The server checks each build (`checkSwapCalldata`), but a compromised server could set both the
// card's "at least" figure and the signed minimum near zero and pass every check that only compares the
// server's numbers with each other. These run in the browser on every build, for every panel:
//  - `signedFloorProblem`: the calldata is the trade asked for (the tokens, worked out from the person's
//    own request, the amount, the recipient), it has no fee, no permit and no split above its amount, its
//    signed minimum is exactly the shown `minAmountOut`, and that minimum is no lower than the quote less
//    the person's own slippage setting (one bp of rounding allowed);
//  - `poolPriceProblem`: the quote itself is within `MAX_POOL_GAP_BPS` of the stock's Aero pool price,
//    which the browser reads from the chain itself (`slot0`), so this one doesn't rely on the server at all.
// Pure, so the tests drive them directly. Known gap: a meme buy gets only the first (its pool comes from
// the server-written allowlist, so a browser price read would not be independent anyway); its $1,000 cap
// bounds it. And the price check is a backstop, not a tight bound: a compromised server could still take
// up to the gap plus slippage, so the server's own checks remain the main ones.
import { getAddress, type Hex } from 'viem';
import { USDC, type CbStock } from '../stocks/tokens';
import { decodeSwapDesc, type SwapTx } from './swap';

/** How much worse than the pool's own price a quote may be. Live KyberSwap quotes on 2026-11-19: $20k buys
 *  in the thin pools (MRVLc, AVGOc, LLYc, HIMSc) 0.4-0.6% worse, $20k sells 0.4-1.1%, and $20k sells into
 *  the ~$50k pools up to 5.2% (ULc; NIOc 4.2%, SONYc 2.8%); the largest buy allowed in those pools
 *  (~$5k, 10% of depth) 0.01-3.2% (SONYc the worst). So 5% lets every normal trade through and asks
 *  only a sale of about 40% of a small pool to be smaller. A server that sets the quote near zero is caught. */
export const MAX_POOL_GAP_BPS = 500;

export function signedFloorProblem(
  tx: SwapTx,
  asked: { amountIn: string; account: `0x${string}`; slippageBps: number; tokenIn: `0x${string}`; tokenOut: `0x${string}` },
): string | null {
  const d = decodeSwapDesc(tx.data as Hex);
  if (!d) return 'the swap does not decode';
  if (d.srcToken !== getAddress(asked.tokenIn) || getAddress(tx.tokenIn) !== d.srcToken) return 'the swap pays with a different token';
  if (d.dstToken !== getAddress(asked.tokenOut)) return 'the swap buys a different token';
  if (d.feeReceivers > 0 || d.feeAmounts > 0) return 'the swap takes a fee';
  if (d.permit !== '0x') return 'the swap carries a permit';
  if (d.srcAmountsTotal > d.amountIn) return 'the swap’s split amounts exceed what it spends';
  if (d.amountIn !== BigInt(asked.amountIn) || BigInt(tx.quote.amountIn) !== d.amountIn) return 'the swap spends a different amount than you asked';
  if (d.recipient !== getAddress(asked.account)) return 'the swap pays someone else';
  if (d.minReturn !== BigInt(tx.minAmountOut)) return 'the swap’s minimum is not the one shown';
  const out = BigInt(tx.quote.amountOut);
  if (out <= BigInt(0) || d.minReturn <= BigInt(0)) return 'the swap has no minimum';
  // minimum ≥ quote × (10000 − slippage − 1) / 10000
  if (d.minReturn * BigInt(10000) < out * BigInt(10000 - asked.slippageBps - 1)) return 'the swap’s minimum is below your slippage limit';
  return null;
}

/** USD per whole token (raw units ÷ 10^decimals, no multiplier) at a pool's sqrtPriceX96. */
export function poolUsdPerToken(sqrtPriceX96: bigint, stock: CbStock): number {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const raw1Per0 = sqrtP * sqrtP;
  const usdcIsToken0 = stock.pool.token0 === 'USDC';
  // token1 raw per token0 raw → stock raw per USDC raw (or the inverse), then to whole units.
  const stockRawPerUsdcRaw = usdcIsToken0 ? raw1Per0 : 1 / raw1Per0;
  return 1 / (stockRawPerUsdcRaw * 10 ** (USDC.decimals - stock.decimals));
}

export function poolPriceProblem(tx: SwapTx, stock: CbStock, sqrtPriceX96: bigint): string | null {
  const price = poolUsdPerToken(sqrtPriceX96, stock);
  if (!Number.isFinite(price) || price <= 0) return 'the pool price could not be read';
  const inAmt = Number(tx.quote.amountIn);
  const outAmt = Number(tx.quote.amountOut);
  const usdIn = tx.quote.side === 'buy' ? inAmt / 10 ** USDC.decimals : (inAmt / 10 ** stock.decimals) * price;
  const usdOut = tx.quote.side === 'buy' ? (outAmt / 10 ** stock.decimals) * price : outAmt / 10 ** USDC.decimals;
  if (usdOut < usdIn * (1 - MAX_POOL_GAP_BPS / 10000)) return `the quote is over ${MAX_POOL_GAP_BPS / 100}% worse than ${stock.symbol}'s pool price; if the amount is large for this pool, try a smaller one`;
  return null;
}
