import { getStock } from './tokens';
import { getCachedPoolState, midPriceUsd, MULTIPLIER_ONE } from './quote';
import { getCachedLiquidityDistribution } from './depth';
import { simulateSell, maxSellAtAvgPrice } from './swapSim';
import { getMorphoStockMarkets } from './morpho';
import { getAaveStockLending, type AaveHubTotals } from './aave';
import type { StockLendingMarket } from './lendingMarket';
import { SELL_CURVE_SIZES_USD, type SellCurvePoint } from './liquidationMath';

// "If this loan is liquidated, can Aerodrome actually absorb the sale?"
// Morpho and Aave both liquidate on their oracle price; a liquidator who has
// to sell the seized stock on Aerodrome only makes money if the average fill
// stays above oracle / LIF (each market carries its own LIF). Everything here
// is a snapshot of the pool right now.

export interface MarketRisk extends StockLendingMarket {
  /** Oracle price per displayed share (B20 multiplier applied). */
  oraclePriceUsd: number;
  aeroMidUsd: number;
  /** (Aero mid - oracle) / oracle, in bp. Negative = Aero is cheaper than the oracle. */
  aeroVsOracleBp: number;
  /** Largest seized-collateral amount (USD at the oracle price) a liquidator
   *  can sell on Aerodrome right now and still not lose money. */
  profitableLiquidationCapacityUsd: number;
  /** The capacity ran into the edge of the scanned window: the true number is at least this. */
  capacityIsLowerBound: boolean;
  /** Average fill if the market's entire collateral were sold on Aerodrome at once. */
  fullUnwind: { discountBp: number; exhaustedWindow: boolean };
}

export interface StockLiquidationRisk {
  symbol: string;
  aeroMidUsd: number;
  sellCurve: SellCurvePoint[];
  markets: MarketRisk[];
}

export interface StockLendingMarkets {
  markets: StockLendingMarket[];
  /** Aave's shared USDC pool; null when Aave could not be read. */
  aaveHub: AaveHubTotals | null;
}

/** Morpho and Aave together. One lender failing leaves the other on the page; both failing throws. */
export async function getStockLendingMarkets(): Promise<StockLendingMarkets> {
  const [morpho, aave] = await Promise.allSettled([getMorphoStockMarkets(), getAaveStockLending()]);
  if (morpho.status === 'rejected' && aave.status === 'rejected') throw morpho.reason;
  return {
    markets: [...(morpho.status === 'fulfilled' ? morpho.value : []), ...(aave.status === 'fulfilled' ? aave.value.markets : [])],
    aaveHub: aave.status === 'fulfilled' ? aave.value.hub : null,
  };
}

export async function getStockLiquidationRisk(symbol: string, markets?: StockLendingMarket[]): Promise<StockLiquidationRisk | null> {
  const stock = getStock(symbol);
  if (!stock) return null;
  const all = markets ?? (await getStockLendingMarkets()).markets;
  const mine = all.filter((m) => m.symbol === stock.symbol && m.oraclePriceUsd != null);

  const state = await getCachedPoolState(stock);
  const dist = await getCachedLiquidityDistribution(stock, state);
  const mid = midPriceUsd(state, stock);
  const multiplierRatio = Number(state.multiplier) / MULTIPLIER_ONE;

  const sellCurve = SELL_CURVE_SIZES_USD.map((usd) => {
    const r = simulateSell(state, dist, stock, usd / mid);
    return { usd, discountBp: r.discountBp, exhaustedWindow: r.exhaustedWindow };
  });

  const marketRisks = mine.map((m): MarketRisk => {
    const oracle = m.oraclePriceUsd! / multiplierRatio;
    const lif = m.liquidationIncentiveFactor;
    const cap = maxSellAtAvgPrice(state, dist, stock, oracle / lif);
    const unwind = simulateSell(state, dist, stock, m.collateralUsd / oracle);
    return {
      ...m,
      oraclePriceUsd: oracle,
      aeroMidUsd: mid,
      aeroVsOracleBp: ((mid - oracle) / oracle) * 10_000,
      profitableLiquidationCapacityUsd: cap.shares * oracle,
      capacityIsLowerBound: cap.exhaustedWindow,
      fullUnwind: { discountBp: unwind.discountBp, exhaustedWindow: unwind.exhaustedWindow },
    };
  });

  return { symbol: stock.symbol, aeroMidUsd: mid, sellCurve, markets: marketRisks };
}

/** Every tracked stock with at least one Morpho or Aave market, in one pass. */
export async function getAllLiquidationRisk(): Promise<{ stocks: StockLiquidationRisk[]; aaveHub: AaveHubTotals | null }> {
  const { markets, aaveHub } = await getStockLendingMarkets();
  const symbols = [...new Set(markets.map((m) => m.symbol))];
  const results = await Promise.all(symbols.map((s) => getStockLiquidationRisk(s, markets).catch(() => null)));
  return { stocks: results.filter((r): r is StockLiquidationRisk => r != null && r.markets.length > 0), aaveHub };
}
