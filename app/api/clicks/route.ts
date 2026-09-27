import { NextRequest, NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { logClick, type ClickVenue } from '@/lib/clicks';
import { clickLimiter } from '@/lib/ratelimit';

export const revalidate = 0;

const VALID_VENUES: ClickVenue[] = ['aerodrome-swap', 'aerodrome-deposit'];

function callerIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

// Fire-and-forget target for navigator.sendBeacon() from HomeClient's
// Execute buttons — exists purely to prove sized, geo-gated outbound flow
// for a future partner/referral conversation (see lib/clicks.ts). Never
// blocks or gates the outbound link itself: this logs a click that's
// already happening, it doesn't decide whether it's allowed to.
export async function POST(request: NextRequest) {
  if (clickLimiter) {
    const { success } = await clickLimiter.limit(callerIp(request));
    if (!success) {
      // Silently drop rather than 429 — sendBeacon has no error handling on
      // the caller's side anyway, and this is best-effort logging, not a
      // flow the user is waiting on.
      return new NextResponse(null, { status: 204 });
    }
  }

  let body: unknown;
  try {
    // sendBeacon sends a Blob with a generic content-type, not
    // application/json, so request.json() can't be trusted to parse it —
    // read as text and parse manually instead.
    body = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const { symbol, usdIn, venue, direction } = (body ?? {}) as Record<string, unknown>;

  if (typeof symbol !== 'string' || !getStock(symbol)) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }
  if (typeof venue !== 'string' || !VALID_VENUES.includes(venue as ClickVenue)) {
    return NextResponse.json({ error: 'unknown venue' }, { status: 400 });
  }
  if (direction !== undefined && direction !== 'buy' && direction !== 'sell') {
    return NextResponse.json({ error: 'direction must be "buy" or "sell"' }, { status: 400 });
  }
  const usdInNum = typeof usdIn === 'number' && Number.isFinite(usdIn) && usdIn > 0 ? usdIn : null;

  // Country comes from Vercel's own edge header, never from the client body
  // — see lib/clicks.ts's ClickRecord comment for why that matters here.
  const country = request.headers.get('x-vercel-ip-country');

  await logClick({
    symbol,
    usdIn: usdInNum,
    venue: venue as ClickVenue,
    direction: direction as 'buy' | 'sell' | undefined,
    country,
    ts: Date.now(),
  });

  return new NextResponse(null, { status: 204 });
}
