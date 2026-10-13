// The gap a page leads with and the sentence that goes with a shared link. Pure (types only from
// lib/tape), so the page on screen (HomeClient), the share snapshot (lib/shareSnapshot.ts) and the
// card (lib/ogImage.tsx) compute the same number and the same words from the same tape.
import type { TapeResult, TapeRow } from './tape';
import { gapSizeText } from './format';
import { basketLabel, type BasketLeg } from './customBasket';

type Session = TapeResult['session'];

export function shortName(row: { name: string; cashTicker: string }): string {
  const name = row.name.replace(/(?:[, ]+(?:Inc\.?|Corporation|Corp\.?|Co\.?))+$/i, '').trim();
  return name && name.length <= 22 ? `${name} (${row.cashTicker})` : row.cashTicker;
}

/** A stock page's headline gap. While the cash market is shut it is anchored to the actual close
 *  (same basis /today uses), not a live extended-hours print, so the sentence, the big number,
 *  the card and /today never disagree about the same instant. */
export function heroGapBp(row: TapeRow | null | undefined, session: Session): number | null {
  if (!row) return null;
  return session.state.startsWith('closed') && row.closeUsd != null && row.onchainMidUsd != null
    ? ((row.onchainMidUsd - row.closeUsd) / row.closeUsd) * 10_000
    : row.basisBp;
}

/** What a stock's gap is measured against, in words: "the cash price", "Friday’s close",
 *  "the cash pre-market price". Before the open and after the close the row only holds an
 *  extended-hours price when Yahoo had a real print (cashPriceType); without one, "cash" is still
 *  the last regular close, so the label must say so. */
export function heroReferenceLabel(row: TapeRow | null | undefined, tape: Pick<TapeResult, 'rows' | 'session'>): string {
  const state = tape.session.state;
  if (state === 'open') return 'the cash price';
  const onExtendedPrint = row?.cashPriceType === 'pre-market' || row?.cashPriceType === 'after-hours';
  const usingClose = state.startsWith('closed') || !onExtendedPrint;
  if (!usingClose) return `the cash ${state === 'pre-market' ? 'pre-market' : 'after-hours'} price`;
  const closedAt = Math.max(0, ...tape.rows.map((r) => r.closeAsOfMs ?? 0));
  if (closedAt <= 0) return 'the cash close';
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date(closedAt));
  return `${weekday}’s close`;
}

export function stockShareText(row: TapeRow | null | undefined, tape: Pick<TapeResult, 'rows' | 'session'>): string {
  const gap = heroGapBp(row, tape.session);
  return row && gap != null
    ? `${shortName(row)} is trading ${gapSizeText(gap)} ${gap >= 0 ? 'above' : 'below'} ${heroReferenceLabel(row, tape)} on Aerodrome.`
    : 'Cash close vs the Aerodrome price for Coinbase tokenized stocks on Base.';
}

export function todayShareText(symbol: string, gapBp: number, marketOpen: boolean): string {
  return `${symbol} is trading ${gapSizeText(gapBp)} ${gapBp >= 0 ? 'above' : 'below'} the cash ${marketOpen ? 'price' : 'close'} on Aerodrome.`;
}

export function basketShareText(legs: BasketLeg[], gapBp: number | null, reference: string): string {
  return gapBp != null
    ? `My custom basket (${basketLabel(legs)}) is trading ${gapSizeText(gapBp)} ${gapBp >= 0 ? 'above' : 'below'} ${reference} on Aerodrome.`
    : `My custom basket of Base tokenized stocks: ${basketLabel(legs)}.`;
}
