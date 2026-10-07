// Card version 3. Bump this number whenever lib/ogImage.tsx changes: the ?hash on the image URL
// is computed from this file alone, and link previews (X, Telegram) cache by that URL.
import { buildOgImage, OG_ALT, OG_SIZE } from '@/lib/ogImage';

export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';

export default async function Image({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  return buildOgImage(symbol);
}
