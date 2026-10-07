import type { MetadataRoute } from 'next';
import { STOCKS } from '@/lib/tokens';
import { siteUrl } from '@/lib/siteUrl';

// The pages people land on: home, the biggest-gap page, Baskets and its risks page, and one page
// per tracked stock (so it follows lib/tokens.ts by itself). All of it is live data.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${siteUrl}/`, lastModified: now, changeFrequency: 'hourly', priority: 1 },
    { url: `${siteUrl}/today`, lastModified: now, changeFrequency: 'hourly', priority: 0.9 },
    { url: `${siteUrl}/baskets`, lastModified: now, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${siteUrl}/baskets/risks`, lastModified: now, changeFrequency: 'monthly', priority: 0.4 },
    ...STOCKS.map((s) => ({ url: `${siteUrl}/${s.symbol}`, lastModified: now, changeFrequency: 'hourly' as const, priority: 0.7 })),
  ];
}
