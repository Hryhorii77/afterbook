import { NextRequest, NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { loanHealthReport } from '@/lib/lending/loanReport';
import { DEFAULT_ALERT_HEALTH } from '@/lib/lending/loanHealth';
import { limitRead } from '@/lib/server/readGuard';

export const revalidate = 0;

// A wallet's Aave and Morpho stock loans on Base for "Look up a wallet" on /borrow (2026-11-26): the same answer as
// the free MCP tool check_loan_health (lib/lending/loanReport.ts). Public positions only; nothing here can sign.
export async function GET(request: NextRequest) {
  const limited = limitRead(request, 'loans', 'lots');
  if (limited) return limited;
  const address = request.nextUrl.searchParams.get('address');
  if (!address || !isAddress(address)) return NextResponse.json({ error: 'valid address required' }, { status: 400 });
  try {
    return NextResponse.json(await loanHealthReport(getAddress(address.toLowerCase()), DEFAULT_ALERT_HEALTH));
  } catch (err) {
    console.error('[/api/loans]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'loans unavailable' }, { status: 502 });
  }
}
