import { NextRequest, NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { addressOfBasename, resolveBasename } from '@/lib/wallet/basename';
import { normalizeBasename } from '@/lib/wallet/walletInput';
import { limitRead } from '@/lib/server/readGuard';

export const revalidate = 0;

// ?address=0x… → { name } (a reverse name that also points back to the address), or ?name=jesse(.base.eth) →
// { address } (2026-11-26, for "Look up a wallet"). Chain reads only.
export async function GET(request: NextRequest) {
  const limited = limitRead(request, 'basename', 'basename');
  if (limited) return limited;
  const nameParam = request.nextUrl.searchParams.get('name');
  if (nameParam != null) {
    const name = normalizeBasename(nameParam);
    if (!name) return NextResponse.json({ error: 'valid Basename required' }, { status: 400 });
    try {
      return NextResponse.json({ name, address: await addressOfBasename(name) });
    } catch (err) {
      console.error('[/api/basename] name', err instanceof Error ? err.message : err);
      return NextResponse.json({ error: 'lookup unavailable' }, { status: 502 });
    }
  }
  const address = request.nextUrl.searchParams.get('address');
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 });
  }

  const name = await resolveBasename(address);
  return NextResponse.json({ name });
}
