import { NextResponse } from 'next/server';
import { STOCKS } from '@/lib/tokens';
import { getSessionInfo } from '@/lib/marketClock';
import { midPriceUsd, readPoolState } from '@/lib/quote';

export const revalidate = 0; // we manage our own short cache below

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const CACHE_TTL_MS = 20_000;

interface TapeRow {
  symbol: string;
  cashTicker: string;
  name: string;
  cashLastUsd: number | null;
  cashStale: boolean;
  onchainMidUsd: number | null;
  basisBp: number | null;
}

interface CacheEntry {
  data: TapeRow[];
  fetchedAt: number;
}

// Module-level: survives across requests on a warm Vercel lambda instance,
// and doubles as the "last known good" source when upstreams fail.
let cache: CacheEntry | null = null;

async function fetchCashPrice(ticker: string): Promise<number | null> {
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${ticker}?interval=1d&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfterbookTape/1.0)' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === 'number') return price;
    } catch {
      // try next host
    }
  }
  return null;
}

async function buildTape(): Promise<TapeRow[]> {
  const rows = await Promise.all(
    STOCKS.map(async (stock): Promise<TapeRow> => {
      const [cashLast, poolState] = await Promise.all([
        fetchCashPrice(stock.cashTicker),
        readPoolState(stock).catch(() => null),
      ]);

      const onchainMid = poolState ? midPriceUsd(poolState, stock) : null;
      const basisBp =
        cashLast !== null && onchainMid !== null ? ((onchainMid - cashLast) / cashLast) * 10_000 : null;

      return {
        symbol: stock.symbol,
        cashTicker: stock.cashTicker,
        name: stock.name,
        cashLastUsd: cashLast,
        cashStale: false,
        onchainMidUsd: onchainMid,
        basisBp,
      };
    }),
  );
  return rows;
}

export async function GET() {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({
      rows: cache.data,
      fetchedAt: cache.fetchedAt,
      session: getSessionInfo(),
    });
  }

  try {
    const rows = await buildTape();
    // If a symbol's cash price failed live but we have a prior good value,
    // carry it forward marked stale instead of showing a hole in the tape.
    const merged = rows.map((row) => {
      if (row.cashLastUsd !== null) return row;
      const prior = cache?.data.find((r) => r.symbol === row.symbol);
      if (prior?.cashLastUsd != null) {
        return { ...row, cashLastUsd: prior.cashLastUsd, cashStale: true };
      }
      return row;
    });

    cache = { data: merged, fetchedAt: now };
    return NextResponse.json({ rows: merged, fetchedAt: now, session: getSessionInfo() });
  } catch (err) {
    if (cache) {
      return NextResponse.json({
        rows: cache.data.map((r) => ({ ...r, cashStale: true })),
        fetchedAt: cache.fetchedAt,
        session: getSessionInfo(),
        error: 'live fetch failed, showing last known values',
      });
    }
    return NextResponse.json({ error: 'tape unavailable', detail: String(err) }, { status: 502 });
  }
}
