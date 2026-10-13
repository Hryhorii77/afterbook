import { NextRequest, NextResponse } from 'next/server';
import { shareLimiter } from '@/lib/ratelimit';
import { cleanCardSpec, createShareSnapshot } from '@/lib/shareSnapshot';

export const revalidate = 0;

function callerIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

// Called by the Share button when its panel opens: freezes the numbers for this share and returns
// its id (the link's `s`) and the post's sentence, both from one tape read (lib/shareSnapshot.ts).
// Any failure answers an error and the button falls back to a live card and the on-screen text.
export async function POST(request: NextRequest) {
  if (!shareLimiter) return NextResponse.json({ error: 'sharing snapshots unavailable' }, { status: 503 });
  const { success } = await shareLimiter.limit(callerIp(request));
  if (!success) return NextResponse.json({ error: 'too many shares, try again in a few minutes' }, { status: 429 });

  const body = await request.json().catch(() => null);
  const card = cleanCardSpec(body?.card);
  if (!card) return NextResponse.json({ error: 'unknown card' }, { status: 400 });

  const snap = await createShareSnapshot(card).catch(() => null);
  if (!snap) return NextResponse.json({ error: 'no reading to share right now' }, { status: 503 });
  return NextResponse.json(snap);
}
