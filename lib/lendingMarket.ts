// Shape shared by every lender /borrow shows (Morpho, Aave). Pure types: the
// page, the x402 route and lib/liquidationRisk.ts all speak this.

export type LendingVenue = 'morpho' | 'aave';

export interface StockLendingMarket {
  venue: LendingVenue;
  /** Morpho market id, or `aave:<reserveId>` on the Aave V4 spoke. */
  marketId: string;
  symbol: string;
  /** Share of the collateral's value a loan may reach before it can be liquidated (Morpho LLTV, Aave V4 collateral factor). */
  lltv: number;
  /** Collateral a liquidator receives per $1 of debt repaid, net of any protocol cut. */
  liquidationIncentiveFactor: number;
  oracleAddress: `0x${string}`;
  /** USD per token from the market's oracle, read on-chain. null if the read failed. */
  oraclePriceUsd: number | null;
  collateralUsd: number;
  /** Most collateral the market accepts, in USD at the oracle price; null when uncapped or unknown. */
  collateralCapUsd: number | null;
  /** USDC borrowed against this stock. null on Aave, where one USDC pool is lent against every stock
   *  together (see AaveHubTotals); the per-stock split does not exist on-chain. */
  borrowUsd: number | null;
  supplyUsd: number | null;
  /** USDC still available to borrow. */
  liquidityUsd: number | null;
  utilization: number | null;
  borrowApy: number;
  supplyApy: number;
  /** Where to see it at the source: Morpho's market page, or the Aave spoke on BaseScan. */
  url: string;
}
