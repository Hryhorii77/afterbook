// Loan health for the Telegram loan alerts. Pure (no I/O): the bot, the alert cron and the
// replay test all use the same rules. A loan is liquidatable below health 1.00; health is
// collateral value x its collateral factor (Aave V4) or LLTV (Morpho), over the debt.
//
// The edge Afterbook has: lending oracles follow the cash market, which is shut nights and
// weekends, while Aerodrome keeps trading. Health worked out at Aerodrome's price shows where a
// loan is heading before the oracle catches up at the open.
import { getAddress, isAddress } from 'viem';
import type { LendingVenue } from './lendingMarket';

export interface LoanCollateral {
  symbol: string;
  /** Tokens posted. */
  amount: number;
  /** USD per token, from the market's oracle (what liquidation uses). */
  oraclePriceUsd: number;
  /** USD per token on Aerodrome right now; null when the pool could not be read. */
  aeroPriceUsd: number | null;
  /** Share of this collateral's value that counts toward health (Aave collateral factor, Morpho LLTV). */
  collateralFactor: number;
}

export interface WalletLoan {
  venue: LendingVenue;
  /** One Aave spoke position holds every stock together; a Morpho market holds one. */
  collateral: LoanCollateral[];
  debtUsd: number;
  /** At the oracle price; below 1 the loan can be liquidated. */
  healthFactor: number;
}

/** Health if the oracle moved to Aerodrome's price. null when any collateral has no Aerodrome price. */
export function healthAtAero(loan: WalletLoan): number | null {
  if (loan.collateral.some((c) => c.aeroPriceUsd == null)) return null;
  const atOracle = loan.collateral.reduce((s, c) => s + c.amount * c.oraclePriceUsd * c.collateralFactor, 0);
  const atAero = loan.collateral.reduce((s, c) => s + c.amount * c.aeroPriceUsd! * c.collateralFactor, 0);
  return atOracle > 0 ? loan.healthFactor * (atAero / atOracle) : null;
}

/** The lower of the two: what an alert compares with the threshold. */
export function worstHealth(loan: WalletLoan): number {
  const aero = healthAtAero(loan);
  return aero == null ? loan.healthFactor : Math.min(loan.healthFactor, aero);
}

/** How far all its collateral could fall together before liquidation, 0-1 (0 = liquidatable now). */
export function dropToLiquidation(healthFactor: number): number {
  return healthFactor > 1 ? 1 - 1 / healthFactor : 0;
}

/** After this many failed reads in a row (5-minute ticks: 30 minutes) the chat is told its warnings are
 *  paused until the loan can be read again, once per run of failures. */
export const LOAN_READ_FAIL_NOTICE = 6;

export function loanReadFailText(wallet: string): string {
  return `Heads-up for ${short(wallet)}: Afterbook couldn't read this wallet's loans for the last 30 minutes (a lender's price feed or the network didn't answer), so loan warnings are paused until it can. Check the loan on Aave or Morpho directly. Not advice.`;
}

export const DEFAULT_ALERT_HEALTH = 1.2;
export const MIN_ALERT_HEALTH = 1.01;
export const MAX_ALERT_HEALTH = 3;
/** After a loan alert fires it re-arms only once health is back above threshold x this, so a
 *  loan wobbling around the line sends one message, not one per tick (same idea as REARM_RATIO). */
export const LOAN_REARM_FACTOR = 1.05;

/** Next edge-trigger state of a loan rule: true = below the threshold (alert has fired).
 *  `worst` is null when the wallet could not be read: the state is kept, so a failed read can't
 *  re-arm or fire anything. A wallet with no loans has nothing to warn about: re-armed. */
export function nextLoanState(active: boolean, worst: number | null | 'no-loans', threshold: number): boolean {
  if (worst === 'no-loans') return false;
  if (worst == null) return active;
  return active ? worst < threshold * LOAN_REARM_FACTOR : worst < threshold;
}

const venueLabel: Record<LendingVenue, string> = { aave: 'Aave', morpho: 'Morpho' };
const short = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const hf = (n: number) => n.toFixed(2);
const usd = (n: number) => `$${n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;

/** One line per loan: venue, collateral, debt, health now and at Aerodrome's price. */
export function describeLoan(loan: WalletLoan): string {
  const what = loan.collateral.map((c) => c.symbol).join(' + ');
  const aero = healthAtAero(loan);
  const aeroPart = aero == null ? '' : `, ${hf(aero)} at Aero's price`;
  const fall = Math.round(dropToLiquidation(loan.healthFactor) * 100);
  const stocks = loan.collateral.length > 1 ? 'its stocks fall' : `${what} falls`;
  return `${venueLabel[loan.venue]} ${what}: ${usd(loan.debtUsd)} borrowed, health ${hf(loan.healthFactor)}${aeroPart}. Liquidated below 1.00, if ${stocks} about ${fall}%${loan.collateral.length > 1 ? ' together' : ''}.`;
}

export function loanStatusText(wallet: string, loans: WalletLoan[]): string {
  if (loans.length === 0) return `${short(wallet)}: no Aave or Morpho stock loans on Base right now.`;
  return [`${short(wallet)}:`, ...loans.map((l) => `• ${describeLoan(l)}`)].join('\n');
}

/** `links`: an Aave loan's links to the in-app panel with the rescue planner preset (lib/lending/rescueLink.ts). */
export function loanAlertText(wallet: string, loans: WalletLoan[], threshold: number, links?: { repayUrl: string; addUrl: string } | null): string {
  const worst = Math.min(...loans.map(worstHealth));
  // Only Aerodrome's price is below the line: the oracle still looks fine, which is the early warning.
  const byAero = loans.every((l) => l.healthFactor >= threshold);
  const why = byAero
    ? `Health at Aero's price is below ${hf(threshold)}: the lending oracle may follow when the cash market moves.`
    : `Health is below ${hf(threshold)}.`;
  const act = links
    ? [
        'For the Aave loan, these open Afterbook’s Aave panel with the rescue planner set for this warning; it fills the amount from the loan of the wallet you connect, and you check it and sign:',
        `Repay USDC: ${links.repayUrl}`,
        `Add collateral: ${links.addUrl}`,
      ]
    : [];
  return [`Loan warning for ${short(wallet)} (lowest ${hf(worst)}). ${why}`, ...loans.map((l) => `• ${describeLoan(l)}`), ...act, 'Not advice. Afterbook never touches your funds.'].join('\n');
}

/** The heads-up after the close that starts a weekend or holiday (2026-11-22; the alerts cron, once per such
 *  close per watched wallet with a loan): the lenders' prices follow the cash market and can sit still until the
 *  next open while Base keeps trading, so each loan's health at Base's price is what it would show if the open
 *  matched it. `links`: the Aave loan's rescue links, as in a warning. */
export function longBreakText(wallet: string, loans: WalletLoan[], nextOpenDay: string, threshold: number, links?: { repayUrl: string; addUrl: string } | null): string {
  const lines = loans.map((l) => {
    const aero = healthAtAero(l);
    const ifOpen = aero == null ? `Base's price couldn't be read for every stock, health ${hf(l.healthFactor)} now` : `if ${nextOpenDay} opens at Base's price, health ${hf(aero)} (${hf(l.healthFactor)} now)`;
    return `• ${venueLabel[l.venue]} ${l.collateral.map((c) => c.symbol).join(' + ')}, ${usd(l.debtUsd)} borrowed: ${ifOpen}. Liquidated below 1.00.`;
  });
  // Urgent only near the person's own line (owner, 2026-11-22): the lower of health now and at Base's price
  // under 1.25x their alert threshold. Otherwise it leads with "nothing urgent" and carries no rescue links.
  const lowest = Math.min(...loans.map(worstHealth));
  if (lowest >= threshold * HEADS_UP_URGENT_FACTOR) {
    return [
      `Market break check for ${short(wallet)}: nothing urgent. Lowest health ${hf(lowest)}, well above your alert at ${hf(threshold)}. The cash market is shut until ${nextOpenDay}'s open; lenders' stock prices may barely move until then while Base keeps trading.`,
      ...lines,
      'Not advice. Afterbook never touches your funds.',
    ].join('\n');
  }
  const act = links
    ? ['To repay or add collateral on the Aave loan before then (the panel works the amount out from the wallet you connect; you check it and sign):', `Repay USDC: ${links.repayUrl}`, `Add collateral: ${links.addUrl}`]
    : [];
  return [
    `Heads-up for ${short(wallet)}: lowest health ${hf(lowest)}, ${lowest < threshold ? 'below' : 'close to'} your alert at ${hf(threshold)}. The cash market is shut until ${nextOpenDay}'s open; lenders' stock prices may barely move until then while Base keeps trading, and interest keeps running.`,
    ...lines,
    ...act,
    'Not advice. Afterbook never touches your funds.',
  ].join('\n');
}

/** A weekend heads-up is urgent (with rescue links) under the alert threshold times this. */
export const HEADS_UP_URGENT_FACTOR = 1.25;

/** `/watch 0xADDRESS [HEALTH]` arguments: a checksummed address and a threshold, or the reason not. */
export function parseWatchArgs(args: string[]): { wallet: `0x${string}`; threshold: number } | string {
  const [addressArg, hfArg] = args;
  if (!addressArg) return `Usage: /watch 0xADDRESS [HEALTH], e.g. "/watch 0xabc…123 1.3" (default ${DEFAULT_ALERT_HEALTH}).`;
  if (!isAddress(addressArg, { strict: false })) return 'That is not a wallet address (0x followed by 40 hex characters).';
  const threshold = hfArg == null ? DEFAULT_ALERT_HEALTH : Number(hfArg);
  if (!Number.isFinite(threshold) || threshold < MIN_ALERT_HEALTH || threshold > MAX_ALERT_HEALTH) {
    return `Health threshold must be between ${MIN_ALERT_HEALTH} and ${MAX_ALERT_HEALTH} (liquidation happens below 1.00).`;
  }
  return { wallet: getAddress(addressArg), threshold };
}
