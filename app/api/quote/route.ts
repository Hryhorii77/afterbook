import { NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { getBuyQuoter } from '@/lib/lotQuote';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';
  const usdcInRaw = searchParams.get('usdcIn') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  const usdcIn = Number(usdcInRaw);
  if (!Number.isFinite(usdcIn) || usdcIn <= 0) {
    return NextResponse.json({ error: 'usdcIn must be a positive number' }, { status: 400 });
  }
  if (usdcIn > 10_000_000) {
    return NextResponse.json({ error: 'usdcIn too large' }, { status: 400 });
  }

  try {
    const quoter = await getBuyQuoter(stock);
    const estimate = quoter.estimate(usdcIn);
    const curve = quoter.curve();
    return NextResponse.json({ symbol: stock.symbol, ...estimate, curve });
  } catch (err) {
    // The cause goes to the server log, not the response (it can name RPC hosts, contract errors).
    console.error('[/api/quote]', err);
    return NextResponse.json({ error: 'quote unavailable' }, { status: 502 });
  }
}
