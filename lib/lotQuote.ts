import type { CbStock } from './tokens';
import { getCachedPoolState, estimateLot, midPriceUsd, poolFeePpm, CURVE_SIZES_USDC, type LotEstimate, type CurvePoint, type PoolState } from './quote';
import { getCachedLiquidityDistribution, type LiquidityDistribution } from './depth';
import { simulateBuy, simulateSell } from './swapSim';

// Every buy-side size estimate the app serves (Lot Lab via /api/quote, the
// MCP get_quote tool, the x402 quote and execute-link routes, /today's
// sizing cards) goes through here. It walks the pool's real tick liquidity
// (lib/swapSim.ts simulateBuy) instead of estimateLot's single-tick
// constant-product math, which is exact only while a trade stays inside the
// current tick's liquidity and is off in either direction past it, with no
// caveat shown. On 2026-10-12: NVDAc $100k 8.2 vs 14.5 bp walked (an hour
// later, after LPs moved, 7.9 vs 7.9), SPCXc $100k 45.0 vs 38.9.
//
// Same LotEstimate shape as before, so API responses don't change. The one
// change in meaning: largeTradeCaveat is now "the buy ran past the ±25%
// window lib/depth.ts scans", the only point where this estimate stops
// being a walk of real liquidity; impactBp is then the cost of the part
// that fits in the window, a lower bound (the UI shows it as "≥"; TSLAc
// $500k read ≥125 bp with 80% fillable on 2026-10-12). If the tick scan
// itself fails, this falls back to estimateLot rather than failing the quote.

function walked(state: PoolState, dist: LiquidityDistribution, stock: CbStock, usdcIn: number): LotEstimate {
  const r = simulateBuy(state, dist, stock, usdcIn);
  return {
    usdcIn,
    sharesOut: r.sharesOut,
    midPriceUsd: r.midPriceUsd,
    execPriceUsd: r.avgPriceUsd,
    impactBp: r.costBp,
    feeBp: (poolFeePpm(state, stock) / 1_000_000) * 10_000,
    largeTradeCaveat: r.exhaustedWindow,
  };
}

export interface BuyQuoter {
  state: PoolState;
  /** false when the tick scan failed and these are single-tick estimates. */
  walksLiquidity: boolean;
  estimate: (usdcIn: number) => LotEstimate;
  curve: (sizes?: number[]) => CurvePoint[];
  /** USDC it takes to push the average fill this many bp above mid (pool fee included). */
  sizeForImpact: (targetBp: number) => number;
  /** Selling `usdValue` of stock (valued at mid); null if the tick scan failed
   *  (there is no single-tick sell fallback). costBp is how far the average
   *  fill sits below mid, pool fee included. */
  sell: (usdValue: number) => { sharesIn: number; usdcOut: number; execPriceUsd: number; costBp: number; exhaustedWindow: boolean } | null;
}

export async function getBuyQuoter(stock: CbStock): Promise<BuyQuoter> {
  const state = await getCachedPoolState(stock);
  const dist = await getCachedLiquidityDistribution(stock, state).catch(() => null);
  const estimate = (usdcIn: number) => (dist ? walked(state, dist, stock, usdcIn) : estimateLot(state, stock, usdcIn));
  return {
    state,
    walksLiquidity: dist != null,
    estimate,
    curve: (sizes = CURVE_SIZES_USDC) =>
      sizes.map((usdcIn) => {
        const e = estimate(usdcIn);
        return { usdcIn, impactBp: e.impactBp, sharesOut: e.sharesOut, largeTradeCaveat: e.largeTradeCaveat };
      }),
    sell: (usdValue: number) => {
      if (!dist) return null;
      const r = simulateSell(state, dist, stock, usdValue / midPriceUsd(state, stock));
      return { sharesIn: r.sharesIn, usdcOut: r.usdcOut, execPriceUsd: r.avgPriceUsd, costBp: r.discountBp, exhaustedWindow: r.exhaustedWindow };
    },
    sizeForImpact: (targetBp: number) => {
      if (targetBp <= 0) return 0;
      // Cost only rises with size, so bisect; past the scanned window the
      // answer is unknowable, so stop there.
      let hi = 1;
      while (estimate(hi).impactBp < targetBp && !estimate(hi).largeTradeCaveat && hi < 100_000_000) hi *= 4;
      let lo = hi / 4;
      for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2;
        if (estimate(m).impactBp < targetBp) lo = m;
        else hi = m;
      }
      return hi;
    },
  };
}
