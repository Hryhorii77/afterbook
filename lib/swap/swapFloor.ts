// The browser's own floor under every swap it is asked to sign (2026-11-19, from the owner's review of
// #191). The server checks each build (`checkSwapCalldata`), but a compromised server could set both the
// card's "at least" figure and the signed minimum near zero and pass every check that only compares the
// server's numbers with each other. These run in the browser on every build, for every panel:
//  - `signedFloorProblem`: the calldata is the trade asked for (the tokens, worked out from the person's
//    own request, the amount, the recipient), it has no fee, no permit and no split above its amount, its
//    signed minimum is exactly the shown `minAmountOut`, and that minimum is no lower than the quote less
//    the person's own slippage setting (one bp of rounding allowed);
//  - `poolFillProblem`: the quote is at most `MAX_FILL_GAP_BPS` worse than what the stock's own pool would
//    pay for exactly this amount, walked through the pool's real liquidity that the browser reads from the
//    chain itself, so this one doesn't rely on the server at all and accounts for depth.
// Pure, so the tests drive them directly. Known gap: a meme buy gets only the first (its pool comes from
// the server-written allowlist, so a browser price read would not be independent anyway); its $1,000 cap
// bounds it. And the price check is a backstop, not a tight bound: a compromised server could still take
// up to the margin plus slippage, so the server's own checks remain the main ones.
import { getAddress, type Hex } from 'viem';
import { USDC, type CbStock } from '../stocks/tokens';
import { MULTIPLIER_ONE, type PoolState } from '../market/quote';
import type { LiquidityDistribution } from '../market/depth';
import { simulateBuy, simulateSell } from '../market/swapSim';
import { decodeSwapDesc, type SwapTx } from './swap';

/** How much worse a quote may be than the stock's own pool would pay for the same amount: room for the
 *  pool moving between KyberSwap's quote and the browser's read, and for the float walk's rounding. */
export const MAX_FILL_GAP_BPS = 100;

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

/**
 * The quote against what the stock's own pool would pay for exactly this amount, worked out in the browser
 * from the pool's real tick liquidity (`lib/market/depth.ts`, read from public RPC, not the server) walked
 * the way the pool's swap loop does (`lib/market/swapSim.ts`, live fee included). KyberSwap may route
 * through other venues and do better; it must not do worse than this one pool by more than the margin.
 * Unlike the spot price, this accounts for depth: a thin pool fills even a small trade well under spot
 * (INFYc $50 ~10%, owner's sweep 2026-11-19), which is the real market, not a lie.
 */
export function poolFillProblem(tx: SwapTx, stock: CbStock, state: PoolState, dist: LiquidityDistribution): string | null {
  if (stock.pool.token0 !== 'USDC') return 'this pool’s layout is not supported by the price check';
  const mult = Number(state.multiplier) / MULTIPLIER_ONE;
  const inAmt = Number(tx.quote.amountIn);
  const outAmt = Number(tx.quote.amountOut);
  let poolOutRaw: number;
  if (tx.quote.side === 'buy') {
    const r = simulateBuy(state, dist, stock, inAmt / 10 ** USDC.decimals);
    if (r.exhaustedWindow) return `that is more than ${stock.symbol}'s pool can fill within 25% of its price; try a smaller amount`;
    poolOutRaw = (r.sharesOut / mult) * 10 ** stock.decimals;
  } else {
    const r = simulateSell(state, dist, stock, (inAmt / 10 ** stock.decimals) * mult);
    if (r.exhaustedWindow) return `that is more than ${stock.symbol}'s pool can fill within 25% of its price; try a smaller amount`;
    poolOutRaw = r.usdcOut * 10 ** USDC.decimals;
  }
  if (!(poolOutRaw > 0)) return `${stock.symbol}'s pool could not be read to check the quote`;
  if (outAmt < poolOutRaw * (1 - MAX_FILL_GAP_BPS / 10000)) {
    return `the quote is over ${MAX_FILL_GAP_BPS / 100}% worse than ${stock.symbol}'s own pool would pay for this amount`;
  }
  return null;
}
