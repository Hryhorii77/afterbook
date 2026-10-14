// Buying a /build basket in one go: one USDC amount split by the basket's weights into one swap
// per stock (each built and checked by lib/swap.ts like any single swap). Pure, so the panel and
// the test agree on the split.
import type { BasketLeg } from './customBasket';
import { MAX_SWAP_USD } from './swap';

/** Smallest leg worth a transaction: below this the network fee is a big share of it. */
export const MIN_LEG_USDC = 1;
/** The whole basket, not each leg: the per-swap limit applied to the total keeps one buy one size. */
export const MAX_BASKET_USD = MAX_SWAP_USD;
/** How far a leg's price may move between the review and its signature. The review card's
 *  "at least" minimum already allows for it, so a rebuilt leg never signs below what was shown. */
export const BASKET_DRIFT_BPS = 50;

export interface BasketLegAmount {
  symbol: string;
  /** Raw USDC (6 decimals). */
  amountIn: bigint;
}

/** Split raw USDC by whole-percent weights. Floors each leg and gives the remainder to the biggest
 *  weight, so the legs always add up to exactly `totalRaw`. */
export function splitBasketUsdc(totalRaw: bigint, legs: BasketLeg[]): BasketLegAmount[] {
  const out = legs.map((l) => ({ symbol: l.symbol, amountIn: (totalRaw * BigInt(l.weightPct)) / BigInt(100) }));
  const rest = totalRaw - out.reduce((s, l) => s + l.amountIn, BigInt(0));
  const biggest = legs.reduce((b, l, i) => (l.weightPct > legs[b].weightPct ? i : b), 0);
  out[biggest] = { ...out[biggest], amountIn: out[biggest].amountIn + rest };
  return out;
}

/** Why this total can't be split into a basket buy, or null if it can. */
export function basketAmountProblem(totalRaw: bigint, legs: BasketLeg[]): string | null {
  const usd = Number(totalRaw) / 1e6;
  if (usd > MAX_BASKET_USD) return `Basket buys are limited to $${MAX_BASKET_USD.toLocaleString('en-US')}.`;
  const smallest = Math.min(...splitBasketUsdc(totalRaw, legs).map((l) => Number(l.amountIn) / 1e6));
  if (smallest < MIN_LEG_USDC) return `Each stock needs at least $${MIN_LEG_USDC}: enter a bigger amount.`;
  return null;
}

/** The minimum a leg's signed swap must keep: the reviewed minimum less the allowed drift. */
export function legFloor(reviewedMinOut: bigint): bigint {
  return (reviewedMinOut * BigInt(10_000 - BASKET_DRIFT_BPS)) / BigInt(10_000);
}
