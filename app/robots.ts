import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

// Everything public is crawlable; the JSON endpoints under /api are for the site's own pages,
// agents and paying clients, not for search results. Shared links (`?s=…`) must stay allowed:
// X's and Telegram's preview crawlers obey robots.txt, and a `Disallow: /*?s=` here (until
// 2026-10-13) meant every shared link showed on X as a bare URL with no card. Duplicates in
// search are handled by each page's canonical URL instead (lib/shareMeta.ts).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/'] }],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
