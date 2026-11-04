import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { resolveBasename } from '@/lib/wallet/basename';
import { limitRead } from '@/lib/server/readGuard';

export const revalidate = 0;

export async function GET(request: NextRequest) {
  const limited = limitRead(request, 'basename', 'basename');
  if (limited) return limited;
  const address = request.nextUrl.searchParams.get('address');
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 });
  }

  const name = await resolveBasename(address);
  return NextResponse.json({ name });
}
