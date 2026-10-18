import { NextRequest, NextResponse } from 'next/server';
import { discoverMemePools, saveMemeAllowlist } from '@/lib/memestocks';
import { cronAuthorized } from '@/lib/sharedSecret';

export const revalidate = 0;
// About 45 s for ~60 candidate pools (each read on-chain plus a KyberSwap route check).
export const maxDuration = 120;

// Daily: finds Base meme pools quoted in a tracked stock token, verifies each on-chain (lib/memestocks.ts)
// and replaces the /memes allowlist with the ones that pass. ?dry=1 returns the result without saving.
// An empty result is not saved: a Dexscreener or RPC outage must not empty the page.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const dry = request.nextUrl.searchParams.get('dry') === '1';
  try {
    const { allowlist, report } = await discoverMemePools();
    if (!dry && allowlist.pools.length > 0) await saveMemeAllowlist(allowlist);
    return NextResponse.json({ ok: true, dry, saved: !dry && allowlist.pools.length > 0, ...report });
  } catch (err) {
    return NextResponse.json({ ok: false, reason: err instanceof Error ? err.message : 'discovery failed' }, { status: 502 });
  }
}
