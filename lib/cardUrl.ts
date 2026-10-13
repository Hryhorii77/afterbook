// Where a share card image lives. One route (app/card/route.tsx) draws every card, so a page's
// link preview and its "Download card" button get the very same image: the stock the person
// shared (not whatever leads a second later) in the theme they were looking at.
//
// X and Telegram cache a card by its exact URL. Bump CARD_VERSION whenever a card's look changes
// (lib/ogImage.tsx), or previews keep showing the old one; per-share URLs also carry `s`, a
// stamp the share button sets, so a shared link's card is fetched fresh at share time.
export const CARD_VERSION = 5;

export type CardTheme = 'dark' | 'light';

export type CardSpec =
  | { page: 'home' }
  | { page: 'stock'; sym: string }
  | { page: 'today'; sym?: string }
  | { page: 'build'; spec: string };

export function cardPath(card: CardSpec, opts: { theme?: CardTheme; s?: string } = {}): string {
  const q = new URLSearchParams({ page: card.page });
  if ('sym' in card && card.sym) q.set('sym', card.sym);
  if ('spec' in card) q.set('spec', card.spec);
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

/** The share stamp as sent by the share button: short base-36, nothing else passes. */
export function parseStamp(value: string | undefined): string | undefined {
  return value && /^[a-z0-9]{1,16}$/.test(value) ? value : undefined;
}
