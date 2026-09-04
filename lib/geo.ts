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
  const country = h.get('x-vercel-ip-country');

  return {
    country: country ?? null,
    // fail closed: unknown (e.g. local dev, or a host that doesn't set the
    // header) is treated as not-unlocked, same as a US IP.
    nonUs: country !== null && country !== 'US',
  };
}
