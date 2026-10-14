// Pure, dependency-free liquidation math — its own module so the /borrow
// calculator (a client component) and the x402 endpoint run the exact same
// formulas without pulling viem into the browser bundle.

// Morpho Blue's liquidation incentive, from the core contract's constants:
// LIF = min(MAX_LIQUIDATION_INCENTIVE_FACTOR, 1 / (1 - CURSOR * (1 - LLTV)))
// with MAX = 1.15 and CURSOR = 0.3. A liquidator repaying X of debt seizes
// X * LIF of collateral valued at the oracle price.
export function liquidationIncentiveFactor(lltv: number): number {
  return Math.min(1.15, 1 / (1 - 0.3 * (1 - lltv)));
}

// Aave V4 (Spoke.sol): the bonus grows as health falls, from maxBonus x
// liquidationBonusFactor just under health 1 to maxBonus at or below
// healthFactorForMaxBonus, and the protocol keeps liquidationFee of the
// bonus. This takes the smallest bonus, a loan liquidated the moment it
// crosses the line, so the capacity built on it is not overstated.
// Inputs in BPS as the contract stores them (maxLiquidationBonus 10550 = 5.5%).
export function aaveV4LiquidationIncentiveFactor(maxLiquidationBonusBps: number, liquidationBonusFactorBps: number, liquidationFeeBps: number): number {
  const bonus = ((maxLiquidationBonusBps - 10_000) / 10_000) * (liquidationBonusFactorBps / 10_000);
  return 1 + bonus * (1 - liquidationFeeBps / 10_000);
}

/** One point of a sell-side impact curve: selling `usd` of stock (valued at
 *  mid) fills on average `discountBp` below mid, pool fee included. */
export interface SellCurvePoint {
  usd: number;
  discountBp: number;
  /** The sell ran past the scanned window, so the real discount is worse. */
  exhaustedWindow: boolean;
}

// Denser toward the top: pools here hold roughly $0.3–1.5M of USDC near the
// price, and the curve stops being knowable at the first point past that.
export const SELL_CURVE_SIZES_USD = [
  1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000,
  1_000_000, 1_500_000,
];

/** Discount for an arbitrary size, linear between curve points; beyond the
 *  last point (or any exhausted one) returns null — unknown, not extrapolated. */
export function discountAt(curve: SellCurvePoint[], usd: number): number | null {
  if (curve.length === 0 || usd <= 0) return usd <= 0 ? 0 : null;
  if (usd <= curve[0].usd) return curve[0].exhaustedWindow ? null : curve[0].discountBp * (usd / curve[0].usd);
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (usd <= b.usd) {
      if (a.exhaustedWindow || b.exhaustedWindow) return null;
      return a.discountBp + ((b.discountBp - a.discountBp) * (usd - a.usd)) / (b.usd - a.usd);
    }
  }
  return null;
}

export interface PositionRisk {
  /** Oracle price per share at which this position becomes liquidatable. */
  liquidationPriceUsd: number;
  /** How far the oracle price has to fall from now, 0–1. Negative = already liquidatable. */
  dropToLiquidation: number;
  /** Collateral a liquidator seizes to clear the whole debt (capped at what was posted), valued at the price it is sold at.
   *  Aave V4 liquidates only enough to bring health back to its target, so there this is an upper bound. */
  seizedUsd: number;
  /** Average Aero fill discount for selling that much, or null if past what we can see. */
  sellDiscountBp: number | null;
  /** Would a liquidator selling on Aerodrome make money? null when sellDiscountBp is. */
  aeroLiquidationProfitable: boolean | null;
}

/**
 * Risk for one position. Assumes the pool's liquidity shape and the
 * Aero-vs-oracle gap are the same at the liquidation price as they are now —
 * a snapshot, not a forecast; in a real sell-off both usually get worse.
 */
export function positionRisk(args: {
  collateralShares: number;
  borrowUsd: number;
  lltv: number;
  /** The market's own incentive (StockLendingMarket.liquidationIncentiveFactor); defaults to Morpho's from the LLTV. */
  lif?: number;
  oraclePriceUsd: number;
  /** (aeroMid - oracle) / oracle, as a fraction. */
  aeroGap: number;
  curve: SellCurvePoint[];
}): PositionRisk | null {
  const { collateralShares, borrowUsd, lltv, oraclePriceUsd, aeroGap, curve } = args;
  if (!(collateralShares > 0) || !(borrowUsd > 0) || !(lltv > 0) || !(oraclePriceUsd > 0)) return null;
  const lif = args.lif ?? liquidationIncentiveFactor(lltv);
  const liquidationPriceUsd = borrowUsd / (collateralShares * lltv);
  // A loan already past its limit is liquidated at today's price, not at
  // its (higher) liquidation price, and can never give up more than it posted.
  const salePriceUsd = Math.min(liquidationPriceUsd, oraclePriceUsd);
  const seizedUsd = Math.min(borrowUsd * lif, collateralShares * salePriceUsd);
  // The curve is keyed on USD at today's mid. With the same liquidity per
  // tick shifted down to the liquidation price, a sell's relative price move
  // goes as shares / (L * sqrtP), and sqrtP (raw stock per USDC) goes as
  // 1/sqrt(price) — so the equivalent size today is the seized value at Aero
  // prices times sqrt(today / sale price), not a linear rescale.
  const sizeAtTodayMid = seizedUsd * (1 + aeroGap) * Math.sqrt(oraclePriceUsd / salePriceUsd);
  const sellDiscountBp = discountAt(curve, sizeAtTodayMid);
  return {
    liquidationPriceUsd,
    dropToLiquidation: 1 - liquidationPriceUsd / oraclePriceUsd,
    seizedUsd,
    sellDiscountBp,
    aeroLiquidationProfitable: sellDiscountBp == null ? null : (1 + aeroGap) * (1 - sellDiscountBp / 10_000) >= 1 / lif,
  };
}
