import { NextRequest, NextResponse } from 'next/server';
import { carryOverFailed, discoverMemePools, readSavedMemeAllowlist, saveMemeAllowlist } from '@/lib/memestocks';
import { cronAuthorized } from '@/lib/sharedSecret';

export const revalidate = 0;
// About 45 s for ~65 candidate pools (each read on-chain plus a KyberSwap route check). A stock whose
// Dexscreener lookup fails costs up to ~35 s more (three 10 s tries and two pauses); if a bad day runs
// past the limit the run dies before saving and yesterday's list stays.
export const maxDuration = 300;

// Daily: finds Base meme pools quoted in a tracked stock token, verifies each on-chain (lib/memestocks.ts)
// and replaces the /memes allowlist with the ones that pass. ?dry=1 returns the result without saving.
// Nothing is saved unless this run itself verified at least one pool: a Dexscreener or RPC outage must not
// empty the page or re-stamp yesterday's list as checked today. A stock whose Dexscreener lookup failed
// keeps the pools it had in the saved list (one Redis read, only then) for up to three days from their
// last proof (carryOverFailed).
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const dry = request.nextUrl.searchParams.get('dry') === '1';
  try {
    const { allowlist: found, report } = await discoverMemePools();
    const allowlist = report.failedStocks.length > 0 ? carryOverFailed(found, await readSavedMemeAllowlist(), report.failedStocks) : found;
    const save = !dry && found.pools.length > 0;
    if (save) await saveMemeAllowlist(allowlist);
    return NextResponse.json({ ok: true, dry, saved: save, carriedOver: allowlist.pools.length - found.pools.length, ...report });
  } catch (err) {
    return NextResponse.json({ ok: false, reason: err instanceof Error ? err.message : 'discovery failed' }, { status: 502 });
  }
}
