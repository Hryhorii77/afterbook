import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

// Everything public is crawlable; the JSON endpoints under /api are for the site's own pages,
// agents and paying clients, not for search results. "?s=" is the per-share stamp the Share button
// adds so link previews are fetched fresh: same page, so not worth indexing again.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/*?s='] }],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
