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
    return NextResponse.json({ error: 'lots unavailable', detail: String(err) }, { status: 502 });
  }
}
