import { buildOgImage, OG_ALT, OG_SIZE } from '@/lib/ogImage';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';
// Without this, Next prerenders the image once at build time and every
// share shows stale numbers forever — this forces a fresh render (bounded
// by getTape()'s own 20s cache) on every request instead.
export const dynamic = 'force-dynamic';

export default function Image() {
  return buildOgImage();
}
