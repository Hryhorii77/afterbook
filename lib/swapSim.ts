import { USDC, type CbStock } from './tokens';
import { MULTIPLIER_ONE, midPriceUsd, type PoolState } from './quote';
import type { LiquidityDistribution } from './depth';

// Pure, no RPC: simulates swaps against the real tick liquidity — selling
// stock into the pool (stock -> USDC, the side a liquidator trades) and
// buying it (USDC -> stock, what a basket buyer does). lib/quote.ts's estimateLot only models buys and
// only within the current tick; a liquidation can be big enough to walk
// several ranges, so this steps through the real tick buckets lib/depth.ts
// already reconstructs (±25% around the price) the same way the pool's own
// swap loop does.
//
// token0 is USDC and token1 is the stock for every pool (lib/tokens.ts), so a
// sell adds token1, raises sqrtP (raw token1 per token0) and *raises* the
// tick — USD price falls as the tick rises. Within a range of liquidity L,
// moving sqrtP from a to b takes L*(b - a) of token1 in and pays
// L*(1/a - 1/b) of token0 out (Uniswap V3 whitepaper 6.14/6.16).

export interface SellResult {
  sharesIn: number;
  usdcOut: number;
  midPriceUsd: number;
  /** Average fill, USD per share, after the pool fee. */
  avgPriceUsd: number;
  /** How far the average fill is below mid, positive bp (fee included). */
  discountBp: number;
  /** The sell ran past the edge of the scanned window (25% below mid), so
   *  usdcOut only counts what the window holds: a real fill would be worse. */
  exhaustedWindow: boolean;
}

const sqrtAtTick = (tick: number) => Math.sqrt(1.0001 ** tick);

export function simulateSell(state: PoolState, dist: LiquidityDistribution, stock: CbStock, sharesIn: number): SellResult {
  const mid = midPriceUsd(state, stock);
  const multiplierRatio = Number(state.multiplier) / MULTIPLIER_ONE;
  const rawIn = (sharesIn / multiplierRatio) * 10 ** stock.decimals;
  let remaining = rawIn * (1 - stock.pool.feePpm / 1_000_000);

  let s = Number(state.sqrtPriceX96) / 2 ** 96;
  let usdcOutRaw = 0;
  let exhaustedWindow = false;

  // Buckets are sorted by tick; start in the one holding the current tick
  // (the same index rule getLiquidityDistribution uses for state.liquidity).
  let i = dist.buckets.findIndex((b) => b.tickLower <= state.tick && state.tick < b.tickUpper);
  if (i < 0) i = dist.buckets.length;

  while (remaining > 0) {
    const bucket = dist.buckets[i];
    if (!bucket) {
      exhaustedWindow = true;
      break;
    }
    const L = Number(bucket.liquidity);
    const sUpper = sqrtAtTick(bucket.tickUpper);
    if (L > 0 && sUpper > s) {
      const toEdge = L * (sUpper - s);
      if (remaining < toEdge) {
        const sNext = s + remaining / L;
        usdcOutRaw += L * (1 / s - 1 / sNext);
        remaining = 0;
        break;
      }
      usdcOutRaw += L * (1 / s - 1 / sUpper);
      remaining -= toEdge;
    }
    s = Math.max(s, sUpper);
    i++;
  }

  const usdcOut = usdcOutRaw / 10 ** USDC.decimals;
  const avgPriceUsd = sharesIn > 0 ? usdcOut / sharesIn : mid;
  return {
    sharesIn,
    usdcOut,
    midPriceUsd: mid,
    avgPriceUsd,
    discountBp: mid > 0 && sharesIn > 0 ? ((mid - avgPriceUsd) / mid) * 10_000 : 0,
    exhaustedWindow,
  };
}

/**
 * Largest sell (in shares) whose average fill stays at or above minAvgPriceUsd.
 * The average fill only gets worse as size grows, so bisection is valid.
 * Returns 0 when even a tiny sell fills below the floor, and caps at the
 * scanned window (exhausted: true) rather than extrapolating past it.
 */
export function maxSellAtAvgPrice(
  state: PoolState,
  dist: LiquidityDistribution,
  stock: CbStock,
  minAvgPriceUsd: number,
): { shares: number; exhaustedWindow: boolean } {
  const ok = (shares: number) => {
    const r = simulateSell(state, dist, stock, shares);
    return !r.exhaustedWindow && r.avgPriceUsd >= minAvgPriceUsd;
  };
  const mid = midPriceUsd(state, stock);
  if (!(mid > 0)) return { shares: 0, exhaustedWindow: false };
  let lo = 0;
  let hi = 1_000 / mid; // ~$1k
  if (!ok(hi / 1_000)) return { shares: 0, exhaustedWindow: false };
  while (ok(hi)) {
    lo = hi;
    hi *= 4;
    if (hi * mid > 1e10) return { shares: lo, exhaustedWindow: true };
  }
  for (let k = 0; k < 50; k++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  // If the failure at hi was the window running out rather than the price
  // floor, say so: the true answer is at least lo.
  const atHi = simulateSell(state, dist, stock, hi);
  return { shares: lo, exhaustedWindow: atHi.exhaustedWindow && atHi.avgPriceUsd >= minAvgPriceUsd };
}

export interface BuyResult {
  usdcIn: number;
  sharesOut: number;
  midPriceUsd: number;
  /** Average fill, USD per share, pool fee included. */
  avgPriceUsd: number;
  /** How far the average fill is above mid, in bp, pool fee included. */
  costBp: number;
  /** The buy ran past the scanned window (25% above mid): sharesOut only
   *  counts what the window holds, so the real fill would be worse. */
  exhaustedWindow: boolean;
}

/**
 * Buying is the mirror of simulateSell: USDC (token0) goes in, sqrtP falls
 * and the tick falls (USD price rises). Within a range of liquidity L,
 * moving sqrtP from a down to b takes L*(1/b - 1/a) of token0 in and pays
 * L*(a - b) of token1 out. Unlike lib/quote.ts's estimateLot this walks
 * across ranges, so it stays right for a buy bigger than the current tick.
 */
export function simulateBuy(state: PoolState, dist: LiquidityDistribution, stock: CbStock, usdcIn: number): BuyResult {
  const mid = midPriceUsd(state, stock);
  const multiplierRatio = Number(state.multiplier) / MULTIPLIER_ONE;
  let remaining = usdcIn * 10 ** USDC.decimals * (1 - stock.pool.feePpm / 1_000_000);

  let s = Number(state.sqrtPriceX96) / 2 ** 96;
  let stockOutRaw = 0;
  let exhaustedWindow = false;

  let i = dist.buckets.findIndex((b) => b.tickLower <= state.tick && state.tick < b.tickUpper);
  if (i < 0) i = -1;

  while (remaining > 0) {
    const bucket = dist.buckets[i];
    if (!bucket) {
      exhaustedWindow = true;
      break;
    }
    const L = Number(bucket.liquidity);
    const sLower = sqrtAtTick(bucket.tickLower);
    if (L > 0 && sLower < s) {
      const toEdge = L * (1 / sLower - 1 / s);
      if (remaining < toEdge) {
        const sNext = 1 / (1 / s + remaining / L);
        stockOutRaw += L * (s - sNext);
        remaining = 0;
        break;
      }
      stockOutRaw += L * (s - sLower);
      remaining -= toEdge;
    }
    s = Math.min(s, sLower);
    i--;
  }

  const sharesOut = (stockOutRaw / 10 ** stock.decimals) * multiplierRatio;
  const avgPriceUsd = sharesOut > 0 ? usdcIn / sharesOut : mid;
  return {
    usdcIn,
    sharesOut,
    midPriceUsd: mid,
    avgPriceUsd,
    costBp: mid > 0 && sharesOut > 0 ? ((avgPriceUsd - mid) / mid) * 10_000 : 0,
    exhaustedWindow,
  };
}
