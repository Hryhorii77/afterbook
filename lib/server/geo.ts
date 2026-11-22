import { headers } from 'next/headers';

export interface GeoInfo {
  country: string | null;
  nonUs: boolean;
  /** The US or one of its territories (blocked like the US; the copy says "the United States"). */
  us: boolean;
}

/** The US and its territories, which Vercel reports under their own codes (2026-11-22, from an outside review:
 *  a Puerto Rico IP was treated as outside the US). */
export const US_REGIONS = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM']);

// Vercel sets x-vercel-ip-country on every request at the edge. This is a
// best-effort UX gate, not a compliance control — any VPN defeats it. We say
// that plainly in the UI rather than imply it's KYC-grade.
export async function getGeoInfo(): Promise<GeoInfo> {
  const h = await headers();
  // Local `next dev` never gets Vercel's edge header, so the fail-closed gate
  // would lock a developer out of their own machine. DEV_GEO_COUNTRY only
  // applies when NODE_ENV is 'development' — a production build ignores it
  // entirely, so setting it there (by mistake or otherwise) changes nothing.
  const devOverride = process.env.NODE_ENV === 'development' ? process.env.DEV_GEO_COUNTRY : undefined;
  const country = devOverride ?? h.get('x-vercel-ip-country');

  return {
    country: country || null,
    // fail closed: unknown (e.g. local dev, or a host that doesn't set the
    // header) is treated as not-unlocked, same as a US IP.
    // An empty header counts as unknown, like a missing one (fail closed).
    nonUs: !!country && !US_REGIONS.has(country),
    us: !!country && US_REGIONS.has(country),
  };
}
