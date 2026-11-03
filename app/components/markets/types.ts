// Shapes of the /api responses the Markets page (HomeClient) reads.

export interface CurvePoint {
  usdcIn: number;
  impactBp: number;
  sharesOut: number;
  largeTradeCaveat: boolean;
}

export interface QuoteResponse {
  symbol: string;
  usdcIn: number;
  sharesOut: number;
  midPriceUsd: number;
  execPriceUsd: number;
  impactBp: number;
  feeBp: number;
  largeTradeCaveat: boolean;
  curve: CurvePoint[];
}

export interface HistorySample {
  ts: number;
  basisBp: number;
}

export interface ClosedPeriodStats {
  count: number;
  meanBp: number;
  meanAbsBp: number;
  maxAbsBp: number;
}

export interface OpenSnapStats {
  days30: number;
  revertedPct30: number;
  days90: number;
  revertedPct90: number;
}

export interface EventLogEntry {
  ts: number;
  text: string;
}

export interface LiquidityBucket {
  tickLower: number;
  tickUpper: number;
  priceLowerUsd: number;
  priceUpperUsd: number;
  liquidity: string;
}

export interface DepthResponse {
  symbol: string;
  currentTick: number;
  currentPriceUsd: number;
  buckets: LiquidityBucket[];
  fullRangeFeeAprPct: number | null;
  feeAprWindowDays: number | null;
  feeAprEstimated: boolean;
  totalSupplyShares: number | null;
}

export interface PriceSample {
  ts: number;
  priceUsd: number;
}

export interface EarningsMoveStats {
  count: number;
  meanAbsMovePct: number;
}

export interface PriceRange {
  lowUsd: number;
  highUsd: number;
}
