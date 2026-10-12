import { getStock } from './tokens';
import { getCachedPoolState, midPriceUsd, MULTIPLIER_ONE } from './quote';
import { getCachedLiquidityDistribution } from './depth';
import { simulateSell, maxSellAtAvgPrice } from './sellSim';
import { getMorphoStockMarkets, type MorphoStockMarket } from './morpho';
import { liquidationIncentiveFactor, SELL_CURVE_SIZES_USD, type SellCurvePoint } from './liquidationMath';

// "If this loan is liquidated, can Aerodrome actually absorb the sale?"
// Morpho liquidates on the oracle price; a liquidator who has to sell the
// seized stock on Aerodrome only makes money if the average fill stays above
// oracle / LIF. Everything here is a snapshot of the pool right now.

export interface MarketRisk extends MorphoStockMarket {
  liquidationIncentiveFactor: number;
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

export async function getStockLiquidationRisk(symbol: string, markets?: MorphoStockMarket[]): Promise<StockLiquidationRisk | null> {
  const stock = getStock(symbol);
  if (!stock) return null;
  const all = markets ?? (await getMorphoStockMarkets());
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
    const lif = liquidationIncentiveFactor(m.lltv);
    const cap = maxSellAtAvgPrice(state, dist, stock, oracle / lif);
    const unwind = simulateSell(state, dist, stock, m.collateralUsd / oracle);
    return {
      ...m,
      liquidationIncentiveFactor: lif,
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

/** Every tracked stock that has at least one listed Morpho market, in one pass. */
export async function getAllLiquidationRisk(): Promise<StockLiquidationRisk[]> {
  const markets = await getMorphoStockMarkets();
  const symbols = [...new Set(markets.map((m) => m.symbol))];
  const results = await Promise.all(symbols.map((s) => getStockLiquidationRisk(s, markets).catch(() => null)));
  return results.filter((r): r is StockLiquidationRisk => r != null && r.markets.length > 0);
}
