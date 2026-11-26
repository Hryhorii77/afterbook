// A stock page link that arrives with the buy amount filled in (2026-11-26): `/NVDAc?side=buy&usdc=100#execute`, from
// an agent (x402 execute-link) or anyone. It only fills the page's own amount field: the amount is quoted live like a
// typed one, the person still ticks the eligibility box and signs, and every check and cap stays as it is (the swap
// panel is unchanged). Buy only, whole dollars, at least $1 and at most the swap cap; anything else is ignored. Whole
// dollars on purpose (review, 2026-11-26): the panel floors its starting amount to cents in floating point, so a link
// for $19.99 would show 19.98 there. Pure; safe for the browser.
import { MAX_SWAP_USD } from './swap';

const AMOUNT_RE = /^\d{1,6}$/;

/** The USDC amount a link asks to fill in, or null when it asks for none (or for anything not allowed). */
export function parsePrefill(params: { side?: string | null; usdc?: string | null }): number | null {
  if (params.side != null && params.side !== 'buy') return null;
  const raw = params.usdc?.trim();
  if (!raw || !AMOUNT_RE.test(raw)) return null;
  const usdc = Number(raw);
  return Number.isFinite(usdc) && usdc >= 1 && usdc <= MAX_SWAP_USD ? usdc : null;
}

/** The stock page's address with a buy amount filled in (rounded down to whole dollars), or without one when it
 *  isn't allowed. */
export function prefillPath(symbol: string, usdc: number | null | undefined): string {
  const amount = usdc != null && Number.isFinite(usdc) ? parsePrefill({ side: 'buy', usdc: String(Math.floor(usdc)) }) : null;
  return amount != null ? `/${symbol}?side=buy&usdc=${amount}#execute` : `/${symbol}#execute`;
}
