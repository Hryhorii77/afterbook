// One wallet's stock loans on Base as data for agents: the paid /api/v1/x402/loan-health route and the free MCP
// tool check_loan_health (2026-11-22) give the same answer from the same reads as the Telegram loan alerts
// (loanPositions.ts, loanHealth.ts). Read-only: public positions, nothing a wallet could sign; an Aave loan's
// links open Afterbook's Aave panel with the rescue planner set, where the person checks and signs.
import 'server-only';
import { getWalletLoans } from './loanPositions';
import { describeLoan, dropToLiquidation, healthAtAero, worstHealth } from './loanHealth';
import { rescueLinks } from './rescueLink';
import { getSessionInfo, longBreakClose, nextOpenWeekday } from '../market/marketClock';
import { siteUrl } from '../share/siteUrl';

const round = (n: number | null) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 1000) / 1000);

export async function loanHealthReport(wallet: `0x${string}`, threshold: number, now = new Date()) {
  const loans = await getWalletLoans(wallet);
  const session = getSessionInfo(now);
  // Only while the cash market is fully shut (overnight, weekend, holiday): in pre-market and after-hours it trades.
  const cashShut = session.state.startsWith('closed');
  return {
    wallet,
    threshold,
    // While the cash market is shut the lenders' oracles mostly stand still and Base keeps trading: health at
    // Base's price is what the loan would show if the next open matched it.
    market: { state: session.state, nextOpen: session.nextOpenIso, nextOpenDay: nextOpenWeekday(now), longBreak: longBreakClose(now) != null },
    loans: loans.map((l) => {
      const worst = worstHealth(l);
      const atBase = round(healthAtAero(l));
      return {
        venue: l.venue,
        collateral: l.collateral.map((c) => ({ symbol: c.symbol, amount: c.amount, oraclePriceUsd: c.oraclePriceUsd, aeroPriceUsd: c.aeroPriceUsd, collateralFactor: c.collateralFactor })),
        debtUsd: Math.round(l.debtUsd * 100) / 100,
        healthFactor: round(l.healthFactor),
        healthAtAero: atBase,
        /** Health if the next open matches Base's price now (null unless the cash market is fully shut: overnight, a weekend or a holiday). */
        healthIfNextOpenAtBase: cashShut ? atBase : null,
        worstHealth: round(worst),
        /** How far all the collateral could fall together, at the oracle, before liquidation (0-1). */
        dropToLiquidation: round(dropToLiquidation(l.healthFactor)),
        belowThreshold: worst < threshold,
        summary: describeLoan(l),
        // Where a person repays or adds collateral, signed in their own wallet (Aave only).
        actions: rescueLinks(l, threshold, siteUrl),
      };
    }),
    note: 'Liquidation happens below health 1.00. Health at Aero’s price (Base) shows where the oracle may go when the cash market moves. Not advice.',
  };
}
