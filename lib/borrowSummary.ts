// What /borrow leads with, its share sentence and its card, from one set of numbers. Pure (types
// only), so the page, the share snapshot (lib/shareSnapshot.ts) and the card (lib/ogImage.tsx)
// say the same thing about the same moment.
import type { AaveHubTotals } from './aave';
import type { LendingVenue } from './lendingMarket';
import type { StockLiquidationRisk } from './liquidationRisk';
import { usdCompact } from './format';

export interface BorrowSummaryRow {
  symbol: string;
  venue: LendingVenue;
  collateralUsd: number;
  /** Most of it a liquidator could sell on Aerodrome right now and still profit. */
  capacityUsd: number;
  /** The capacity ran to the edge of the scanned pool: the true figure is at least this. */
  capacityIsLowerBound: boolean;
}

export interface BorrowSummary {
  collateralUsd: number;
  borrowUsd: number;
  /** Markets holding at least $1 of collateral, biggest first. */
  rows: BorrowSummaryRow[];
}

export const venueName: Record<LendingVenue, string> = { morpho: 'Morpho', aave: 'Aave' };

export function summarizeBorrow(stocks: StockLiquidationRisk[], aaveHub: AaveHubTotals | null): BorrowSummary {
  const markets = stocks.flatMap((s) => s.markets);
  return {
    collateralUsd: markets.reduce((t, m) => t + m.collateralUsd, 0),
    // Aave lends one USDC pool against every stock, so its borrows count once, from the pool.
    borrowUsd: markets.reduce((t, m) => t + (m.borrowUsd ?? 0), 0) + (aaveHub?.borrowUsd ?? 0),
    rows: markets
      .filter((m) => m.collateralUsd >= 1)
      .sort((a, b) => b.collateralUsd - a.collateralUsd)
      .map((m) => ({
        symbol: m.symbol,
        venue: m.venue,
        collateralUsd: m.collateralUsd,
        capacityUsd: m.profitableLiquidationCapacityUsd,
        capacityIsLowerBound: m.capacityIsLowerBound,
      })),
  };
}

/** More collateral than Aerodrome can absorb at a profit. A lower-bound capacity is still the
 *  ceiling in practice: it is about all the USDC the pool holds within 25% of the price, and fills
 *  past that are far below any liquidation bonus (4.5–15%). */
export const exceedsAero = (r: BorrowSummaryRow) => r.collateralUsd > r.capacityUsd;

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function borrowShareText(s: BorrowSummary): string {
  const over = s.rows.filter(exceedsAero);
  if (over.length > 0) {
    const byVenue = (['aave', 'morpho'] as const)
      .map((v) => ({ v, syms: over.filter((r) => r.venue === v).map((r) => r.symbol) }))
      .filter((g) => g.syms.length > 0)
      .map((g) => `${list(g.syms)} on ${venueName[g.v]}`);
    return `More ${list(byVenue)} is pledged as loan collateral than Aerodrome can absorb in a liquidation at a profit right now.`;
  }
  return `${usdCompact(s.collateralUsd)} of tokenized stocks back USDC loans on Aave and Morpho on Base, and Aerodrome can absorb each market's liquidation at a profit right now.`;
}
