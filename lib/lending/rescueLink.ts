// Links from a loan warning (the Telegram alert, the loan-health API) to the in-app Aave panel on /borrow,
// with the rescue planner (LoanRescue.tsx, lib/lending/rescue.ts) preset to a price fall and a target
// health (2026-11-21). The link carries only that scenario and which field to fill, never an amount or a
// wallet: the planner works the amount out from the connected wallet's live loan and fills the panel's
// own Repay or Add field, and the person reviews and signs with the panel's usual buttons and approvals.
// Pure; safe for the browser.
import { RESCUE_FALLS, RESCUE_TARGETS } from './rescue';
import { healthAtAero, type WalletLoan } from './loanHealth';

export type RescueAction = 'repay' | 'add';
export interface RescuePreset {
  action: RescueAction;
  fall: (typeof RESCUE_FALLS)[number];
  target: (typeof RESCUE_TARGETS)[number];
}

/** The scenario for a loan: the fall the oracle would take to reach Aero's price (the planner's next
 *  step at or above it, at most its largest), and the planner's first target above the alert's line. */
export function rescueScenario(loan: WalletLoan, thresholdHf: number): Omit<RescuePreset, 'action'> {
  const aero = healthAtAero(loan);
  const implied = aero != null && loan.healthFactor > 0 ? Math.max(0, 1 - aero / loan.healthFactor) : 0;
  const fall = RESCUE_FALLS.find((f) => f >= implied - 1e-9) ?? RESCUE_FALLS[RESCUE_FALLS.length - 1];
  const target = RESCUE_TARGETS.find((t) => t > thresholdHf) ?? RESCUE_TARGETS[RESCUE_TARGETS.length - 1];
  return { fall, target };
}

export function rescuePath(p: RescuePreset): string {
  return `/borrow?rescue=${p.action}&fall=${p.fall}&target=${p.target}#borrow-here`;
}

/** Links for an Aave loan (the in-app panel is Aave's MAG7 spoke, the one the alerts read); none for
 *  Morpho, which has no in-app panel. */
export function rescueLinks(loan: WalletLoan, thresholdHf: number, origin: string): { repayUrl: string; addUrl: string } | null {
  if (loan.venue !== 'aave') return null;
  const s = rescueScenario(loan, thresholdHf);
  return { repayUrl: origin + rescuePath({ action: 'repay', ...s }), addUrl: origin + rescuePath({ action: 'add', ...s }) };
}

/** Reads a preset from /borrow's query; anything not exactly one of the planner's own choices is ignored. */
export function parseRescuePreset(params: URLSearchParams): RescuePreset | null {
  const action = params.get('rescue');
  if (action !== 'repay' && action !== 'add') return null;
  const fall = RESCUE_FALLS.find((f) => String(f) === params.get('fall'));
  const target = RESCUE_TARGETS.find((t) => String(t) === params.get('target'));
  if (fall == null || target == null) return null;
  return { action, fall, target };
}
