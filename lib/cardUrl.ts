// Where a share card image lives. One route (app/card/route.tsx) draws every card, so a page's
// link preview and its "Download card" button get the very same image: the stock the person
// shared (not whatever leads a second later) in the theme they were looking at.
//
// X and Telegram cache a card by its exact URL. Bump CARD_VERSION whenever a card's look changes
// (lib/ogImage.tsx), or previews keep showing the old one. Shared URLs also carry `s`, the
// share's snapshot id (lib/shareSnapshot.ts): its card is drawn from the numbers frozen at share time.
export const CARD_VERSION = 15;

export type CardTheme = 'dark' | 'light';

export type CardSpec =
  | { page: 'home' }
  | { page: 'stock'; sym: string }
  | { page: 'today'; sym?: string }
  | { page: 'build'; spec: string }
  | { page: 'borrow' }
  | { page: 'meme'; addr: string };

export function cardPath(card: CardSpec, opts: { theme?: CardTheme; s?: string } = {}): string {
  const q = new URLSearchParams({ page: card.page });
  if ('sym' in card && card.sym) q.set('sym', card.sym);
  if ('spec' in card) q.set('spec', card.spec);
  if ('addr' in card) q.set('addr', card.addr);
  if (opts.theme === 'light') q.set('theme', 'light');
  if (opts.s) q.set('s', opts.s);
  q.set('v', String(CARD_VERSION));
  return `/card?${q.toString()}`;
}

export function parseTheme(value: unknown): CardTheme {
  return value === 'light' ? 'light' : 'dark';
}

/** A query value as one string (Next hands repeated keys over as arrays). */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A share's `s`: a snapshot id (16 hex, lib/shareSnapshot.ts) or the button's fallback stamp
 *  (short base-36). Nothing else passes. */
export function parseStamp(value: string | undefined): string | undefined {
  return value && /^[a-z0-9]{1,16}$/.test(value) ? value : undefined;
}
