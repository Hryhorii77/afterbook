import { NextRequest, NextResponse } from 'next/server';
import { guardSwapRequest } from '@/lib/swapGuard';
import { parseSwapRequest, quoteSwap, SwapError } from '@/lib/swap';

export const revalidate = 0;

// Price preview for the swap panel: what KyberSwap would fill right now, after Afterbook's fee.
// GET ?symbol=NVDAc&side=buy&amountIn=<raw units of the token being sold>
export async function GET(request: NextRequest) {
  const refused = await guardSwapRequest(request);
  if (refused) return refused;
  const p = request.nextUrl.searchParams;
  const req = parseSwapRequest({ symbol: p.get('symbol'), side: p.get('side'), amountIn: p.get('amountIn') });
  if (typeof req === 'string') return NextResponse.json({ error: req }, { status: 400 });
  try {
    return NextResponse.json(await quoteSwap(req));
  } catch (err) {
    return NextResponse.json({ error: err instanceof SwapError ? err.message : 'quote unavailable' }, { status: err instanceof SwapError ? err.status : 502 });
  }
}
