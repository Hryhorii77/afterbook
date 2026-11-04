import { headers } from 'next/headers';

export interface GeoInfo {
  country: string | null;
  nonUs: boolean;
}

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
    country: country ?? null,
    // fail closed: unknown (e.g. local dev, or a host that doesn't set the
    // header) is treated as not-unlocked, same as a US IP.
    nonUs: country !== null && country !== 'US',
  };
}
