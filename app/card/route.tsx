import { NextRequest, NextResponse } from 'next/server';
import { buildAgentsOgImage, buildBasketOgImage, buildBorrowOgImage, buildMemeOgImage, buildOgImage, buildPlanOgImage, buildTodayOgImage } from '@/lib/share/ogImage';
import { readSavedPlan } from '@/lib/agent/savedPlan';
import { PLAN_ID_RE } from '@/lib/agent/planLink';
import { planCardContent } from '@/lib/share/planCard';
import { limitRead } from '@/lib/server/readGuard';
import { parseTheme } from '@/lib/share/cardUrl';
import { getStock } from '@/lib/stocks/tokens';
import { parseSpec } from '@/lib/build/customBasket';
import { getShareSnapshot } from '@/lib/share/shareSnapshot';

export const dynamic = 'force-dynamic';

// Every share card: link previews (each page's og:image / twitter:image, see lib/share/cardUrl.ts)
// and the share panel's "Download card". Query: page=home|stock|today|build|borrow|meme|agents|plan, sym, spec, addr, id,
// theme=light (dark otherwise). `s` is a share's id: when it names a stored snapshot the card is
// drawn from those frozen numbers (the same ones the post's sentence used); otherwise from the live
// tape. `v` only makes the URL unique for link-preview caches.
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const theme = parseTheme(q.get('theme'));

  const snap = await getShareSnapshot(q.get('s') ?? '');
  if (snap) {
    const frozen = { tape: snap.tape, takenAt: snap.takenAt, basketCostBp: snap.basketCostBp };
    const card = snap.card;
    if (card.page === 'stock') return buildOgImage(card.sym, theme, frozen);
    if (card.page === 'today') return buildTodayOgImage(card.sym, theme, frozen);
    if (card.page === 'build') return buildBasketOgImage(card.spec, theme, frozen);
    if (card.page === 'borrow' && snap.borrow) return buildBorrowOgImage(theme, { ...frozen, borrow: snap.borrow });
    if (card.page === 'meme' && snap.meme) return (await buildMemeOgImage(card.addr, theme, snap.meme)) ?? notFound();
  }

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
    case 'borrow':
      return buildBorrowOgImage(theme);
    case 'agents':
      return buildAgentsOgImage(theme);
    case 'plan': {
      // A plan link's card (/plan/<id>): drawn from the saved plan (read through its hour-long data cache), never
      // from the URL. An id that isn't one is a 404; an expired or unknown one gets the plain card. Misses aren't
      // cached, so guessed ids are held to the read limit.
      const id = q.get('id') ?? '';
      if (!PLAN_ID_RE.test(id)) return notFound();
      const limited = limitRead(request, 'card-plan');
      if (limited) return limited;
      const saved = await readSavedPlan(id).catch(() => null);
      return buildPlanOgImage(saved ? planCardContent(saved) : null, theme);
    }
    case 'meme': {
      // Only a meme on the allowlist gets a card; anything else is a 404, never a drawn guess.
      const card = await buildMemeOgImage(q.get('addr') ?? '', theme);
      return card ?? notFound();
    }
    default:
      return notFound();
  }
}

function notFound() {
  return NextResponse.json({ error: 'unknown card' }, { status: 404 });
}
