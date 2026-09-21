// Cash-and-carry basis calculator: how much bp of edge a trade nets after
// the pool's fee, this size's price impact, and a rough gas allowance —
// and what that edge implies annualized over the actual time remaining
// until reopen. Two directions, both long-only (this app has no borrow/
// short mechanism — see lib/quote.ts's own docs on why no real calldata
// gets constructed here either):
//
//  - 'buy' (default): basisBp < 0 — on-chain priced *below* the cash
//    reference (lib/tape.ts: basisBp = (onchainMid - cashRef) / cashRef).
//    Buying now and full convergence up to that reference by reopen is
//    the profitable case, so grossEdgeBp is -basisBp: positive when
//    on-chain is cheap.
//  - 'sell': the inventory-unwind side, for a user who already holds
//    shares (not a new short — nothing here borrows). basisBp > 0 —
//    on-chain priced *above* cash — is the profitable setup: sell the
//    held shares on-chain now at the premium, notionally rebuy the same
//    USDC amount in cash pre-market once it reopens. grossEdgeBp is
//    +basisBp here, the mirror image of the buy case.
//
// GAS_ESTIMATE_USD is a documented flat assumption, not a live
// simulation — this app deliberately never constructs real swap calldata
// (see lib/quote.ts's own docs on why), so there is no real transaction
// to eth_estimateGas against. Base L2 swap gas is well known to run a
// few cents at most; treat this as a conservative, round-number stand-in
// for "what a swap plus the Jensen-style approval overhead roughly
// costs," not a per-trade quote.
export const GAS_ESTIMATE_USD = 0.02;

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export interface CashAndCarryEdge {
  /** -basisBp (direction 'buy') or +basisBp (direction 'sell') — positive
   *  in either case means this direction currently has an edge. */
  grossEdgeBp: number;
  feeBp: number;
  impactBp: number;
  gasBp: number;
  netEdgeBp: number;
  /** Simple (non-compounded) annualization of netEdgeBp over the time
   *  remaining until cash reopens. null when there's no meaningful
   *  forward window (e.g. already past reopen). Over a short window this
   *  can look dramatic (a small real return scaled up to "if this held
   *  for a year") — holdingDays below is what the UI shows alongside it
   *  so that's legible as an extrapolation, not the actual expected loss/gain. */
  annualizedPct: number | null;
  /** Real time until reopen, in days — the actual holding period
   *  annualizedPct extrapolates from. */
  holdingDays: number;
}

export function computeCashAndCarryEdge(
  basisBp: number,
  feeBp: number,
  impactBp: number,
  usdcIn: number,
  msUntilOpen: number,
  direction: 'buy' | 'sell' = 'buy',
): CashAndCarryEdge {
  const grossEdgeBp = direction === 'buy' ? -basisBp : basisBp;
  const gasBp = usdcIn > 0 ? (GAS_ESTIMATE_USD / usdcIn) * 10_000 : 0;
  const netEdgeBp = grossEdgeBp - feeBp - impactBp - gasBp;

  const yearsUntilOpen = msUntilOpen / MS_PER_YEAR;
  const annualizedPct = yearsUntilOpen > 0 ? netEdgeBp / 100 / yearsUntilOpen : null;
  const holdingDays = msUntilOpen / 86_400_000;

  return { grossEdgeBp, feeBp, impactBp, gasBp, netEdgeBp, annualizedPct, holdingDays };
}
