import { buildOgImage, OG_ALT, OG_SIZE } from '@/lib/ogImage';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

export default function Image() {
  return buildOgImage();
}
