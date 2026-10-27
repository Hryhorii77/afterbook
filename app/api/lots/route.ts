import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { getTape } from '@/lib/tape';
import { getMyLots } from '@/lib/lots';

export const revalidate = 0;

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address');
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 });
  }

  try {
    const tape = await getTape();
    const lots = await getMyLots(address, tape.rows);
    return NextResponse.json(lots);
  } catch (err) {
    // The cause goes to the server log, not the response (it can name RPC hosts, contract errors).
    console.error('[/api/lots]', err);
    return NextResponse.json({ error: 'lots unavailable' }, { status: 502 });
  }
}
