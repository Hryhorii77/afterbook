import { NextResponse } from 'next/server';
import { getStock } from '@/lib/tokens';
import { estimateLot, readPoolState } from '@/lib/quote';

interface StateCacheEntry {
  state: Awaited<ReturnType<typeof readPoolState>>;
  fetchedAt: number;
}
const stateCache = new Map<string, StateCacheEntry>();
const CACHE_TTL_MS = 20_000;

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
    const now = Date.now();
    const cached = stateCache.get(stock.symbol);
    const state =
      cached && now - cached.fetchedAt < CACHE_TTL_MS ? cached.state : await readPoolState(stock);
    if (!cached || now - cached.fetchedAt >= CACHE_TTL_MS) {
      stateCache.set(stock.symbol, { state, fetchedAt: now });
    }

    const estimate = estimateLot(state, stock, usdcIn);
    return NextResponse.json({ symbol: stock.symbol, ...estimate });
  } catch (err) {
    return NextResponse.json({ error: 'quote unavailable', detail: String(err) }, { status: 502 });
  }
}
