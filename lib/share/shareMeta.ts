import type { Metadata } from 'next';
import { cardPath, firstParam, parseStamp, parseTheme, type CardSpec } from './cardUrl';
import { OG_ALT, OG_SIZE } from './ogImage';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Title, description, canonical URL and link-preview card for a page. A shared link
 * (`?s=<stamp>&theme=light`, plus `sym` on /today) gets a card for exactly what was shared;
 * the canonical URL drops those params so search engines see one page, while crawlers that
 * draw previews (X, Telegram) may still read the shared URL (robots.txt allows it).
 */
export function shareMetadata(opts: {
  title: string;
  description: string;
  path: string;
  card: CardSpec;
  searchParams?: SearchParams;
}): Metadata {
  const sp = opts.searchParams ?? {};
  const image = {
    url: cardPath(opts.card, { theme: parseTheme(firstParam(sp.theme)), s: parseStamp(firstParam(sp.s)) }),
    ...OG_SIZE,
    alt: OG_ALT,
    type: 'image/png',
  };
  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: opts.path },
    openGraph: { title: opts.title, description: opts.description, url: opts.path, siteName: 'Afterbook', type: 'website', images: [image] },
    twitter: { card: 'summary_large_image', title: opts.title, description: opts.description, images: [image] },
  };
}
