// Card version 4. Bump this number whenever lib/ogImage.tsx changes: the ?hash on the image URL
// is computed from this file alone, and link previews (X, Telegram) cache by that URL.
import { buildBasketOgImage, OG_ALT, OG_SIZE } from '@/lib/ogImage';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

export default async function Image({ params }: { params: Promise<{ spec: string }> }) {
  const { spec } = await params;
  return buildBasketOgImage(spec);
}
