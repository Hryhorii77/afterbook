import { NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';

export const revalidate = 0; // getTape manages its own short cache

export async function GET() {
  try {
    const tape = await getTape();
    // Vercel's edge holds a good tape for 10 s (and serves it up to 20 s more while refreshing), so a
    // burst of visitors doesn't each cost a chain read and 38 Yahoo calls. The page shows the tape's
    // own age (fetchedAt) and says Delayed after 90 s, so the label stays honest. Errors aren't cached.
    return NextResponse.json(tape, { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' } });
  } catch (err) {
    // The cause goes to the server log, not the response (it can name RPC hosts, contract errors).
    console.error('[/api/tape]', err);
    return NextResponse.json({ error: 'tape unavailable' }, { status: 502 });
  }
}
