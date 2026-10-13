import { NextRequest, NextResponse } from 'next/server';
import { buildBasketOgImage, buildOgImage, buildTodayOgImage } from '@/lib/ogImage';
import { parseTheme } from '@/lib/cardUrl';
import { getStock } from '@/lib/tokens';
import { parseSpec } from '@/lib/customBasket';

export const dynamic = 'force-dynamic';

// Every share card: link previews (each page's og:image / twitter:image, see lib/cardUrl.ts)
// and the share panel's "Download card". Query: page=home|stock|today|build, sym, spec,
// theme=light (dark otherwise). `v` and `s` only make the URL unique for link-preview caches.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const theme = parseTheme(q.get('theme'));
  const sym = q.get('sym');
  const stock = sym ? getStock(sym) : undefined;

  switch (q.get('page')) {
    case 'home':
      return buildOgImage(undefined, theme);
    case 'stock':
      return stock ? buildOgImage(stock.symbol, theme) : notFound();
    case 'today':
      // An unknown sym falls back to the live leader rather than failing the preview.
      return buildTodayOgImage(stock?.symbol, theme);
    case 'build': {
      const spec = q.get('spec');
      return spec && parseSpec(spec) ? buildBasketOgImage(spec, theme) : notFound();
    }
    default:
      return notFound();
  }
}

function notFound() {
  return NextResponse.json({ error: 'unknown card' }, { status: 404 });
}
