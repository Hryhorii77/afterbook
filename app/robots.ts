import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/siteUrl';

// Everything public is crawlable; the JSON endpoints under /api are for the site's own pages,
// agents and paying clients, not for search results.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: '/api/' }],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
