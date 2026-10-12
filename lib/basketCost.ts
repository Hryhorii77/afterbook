import { getStock } from './tokens';
import { getCachedPoolState } from './quote';
import { getCachedLiquidityDistribution } from './depth';
import { simulateBuy } from './swapSim';
import type { BasketLeg } from './customBasket';

// What it costs to buy a whole custom basket on Aerodrome right now: each
// leg's USDC slice is walked through that pool's real tick liquidity
// (lib/swapSim.ts), and the basket's cost is the total overpay over mid
// divided by the total spent — the weighted average of the legs' costs.

export const BASKET_SIZES_USD = [1_000, 10_000, 50_000];
/** "Largest buy under X% total cost" uses this cap, pool fee included. */
export const MAX_COST_BP = 100;

export interface BasketCostPoint {
  usd: number;
  costBp: number;
  /** A leg ran past the liquidity Afterbook scans; the real cost is higher. */
  exhaustedWindow: boolean;
}

export interface BasketCost {
  points: BasketCostPoint[];
  /** Per leg at the middle size, so the page can show where the cost comes from. */
  legsAtMid: { symbol: string; usd: number; costBp: number }[];
  /** Largest basket buy whose total cost stays under MAX_COST_BP. */
  maxUsdUnderCap: number;
  maxIsLowerBound: boolean;
}

export async function getBasketCost(legs: BasketLeg[]): Promise<BasketCost> {
  const pools = await Promise.all(
    legs.map(async (leg) => {
      const stock = getStock(leg.symbol)!;
      const state = await getCachedPoolState(stock);
      const dist = await getCachedLiquidityDistribution(stock, state);
      return { leg, stock, state, dist };
    }),
  );

  const costAt = (usd: number) => {
    let overpay = 0;
    let exhausted = false;
    const perLeg = pools.map(({ leg, stock, state, dist }) => {
      const slice = (usd * leg.weightPct) / 100;
      const r = simulateBuy(state, dist, stock, slice);
      overpay += (slice * r.costBp) / 10_000;
      exhausted ||= r.exhaustedWindow;
      return { symbol: leg.symbol, usd: slice, costBp: r.costBp };
    });
    return { costBp: usd > 0 ? (overpay / usd) * 10_000 : 0, exhausted, perLeg };
  };

  const points = BASKET_SIZES_USD.map((usd) => {
    const c = costAt(usd);
    return { usd, costBp: c.costBp, exhaustedWindow: c.exhausted };
  });

  // Cost only rises with size, so bisect; stop growing at $50M.
  const ok = (usd: number) => {
    const c = costAt(usd);
    return !c.exhausted && c.costBp <= MAX_COST_BP;
  };
  let lo = 0;
  let hi = 1_000;
  let maxIsLowerBound = false;
  if (ok(hi)) {
    while (ok(hi)) {
      lo = hi;
      hi *= 2;
      if (hi > 50_000_000) {
        maxIsLowerBound = true;
        break;
      }
    }
    if (!maxIsLowerBound) {
      for (let k = 0; k < 40; k++) {
        const m = (lo + hi) / 2;
        if (ok(m)) lo = m;
        else hi = m;
      }
    }
  }

  return {
    points,
    legsAtMid: costAt(BASKET_SIZES_USD[1]).perLeg,
    maxUsdUnderCap: lo,
    maxIsLowerBound,
  };
}
