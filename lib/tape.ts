import { STOCKS } from './tokens';
import { getSessionInfo, type SessionInfo } from './marketClock';
import { midPriceUsd, poolDepth, readPoolState } from './quote';

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const CACHE_TTL_MS = 20_000;

export interface TapeRow {
  symbol: string;
  cashTicker: string;
  name: string;
  cashLastUsd: number | null;
  /** Epoch ms of the cash price Yahoo returned. During closed sessions this
   *  is frozen at the exact regular-session close instant (verified:
   *  regularMarketTime == currentTradingPeriod.regular.end when the market
   *  isn't live), which is what makes the "closed since" gap math exact. */
  cashAsOfMs: number | null;
  cashStale: boolean;
  onchainMidUsd: number | null;
  basisBp: number | null;
  /** Real pool depth (token.balanceOf(pool)), not the virtual reserves used
   *  for impact math — this is what's actually deployed. */
  depthUsd: number | null;
  depthShares: number | null;
}

export interface TapeResult {
  rows: TapeRow[];
  fetchedAt: number;
  session: SessionInfo;
  error?: string;
}

interface CacheEntry {
  data: TapeRow[];
  fetchedAt: number;
}

// Module-level: survives across requests on a warm Vercel lambda instance,
// and doubles as the "last known good" source when upstreams fail. Shared
// between /api/tape and the opengraph-image generator so both reuse the same
// 20s-fresh data instead of each hitting Yahoo/Base RPC independently.
let cache: CacheEntry | null = null;

interface CashPrice {
  price: number;
  asOfMs: number;
}

async function fetchCashPrice(ticker: string): Promise<CashPrice | null> {
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${ticker}?interval=1d&range=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfterbookTape/1.0)' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const asOf = meta?.regularMarketTime;
      if (typeof price === 'number' && typeof asOf === 'number') {
        return { price, asOfMs: asOf * 1000 };
      }
    } catch {
      // try next host
    }
  }
  return null;
}

async function buildTape(): Promise<TapeRow[]> {
  const rows = await Promise.all(
    STOCKS.map(async (stock): Promise<TapeRow> => {
      const [cash, poolState] = await Promise.all([
        fetchCashPrice(stock.cashTicker),
        readPoolState(stock).catch(() => null),
      ]);

      const onchainMid = poolState ? midPriceUsd(poolState, stock) : null;
      const basisBp =
        cash !== null && onchainMid !== null ? ((onchainMid - cash.price) / cash.price) * 10_000 : null;
      const depth = poolState ? poolDepth(poolState, stock) : null;

      return {
        symbol: stock.symbol,
        cashTicker: stock.cashTicker,
        name: stock.name,
        cashLastUsd: cash?.price ?? null,
        cashAsOfMs: cash?.asOfMs ?? null,
        cashStale: false,
        onchainMidUsd: onchainMid,
        basisBp,
        depthUsd: depth?.totalUsd ?? null,
        depthShares: depth?.stockShares ?? null,
      };
    }),
  );
  return rows;
}

export async function getTape(): Promise<TapeResult> {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { rows: cache.data, fetchedAt: cache.fetchedAt, session: getSessionInfo() };
  }

  try {
    const rows = await buildTape();
    // If a symbol's cash price failed live but we have a prior good value,
    // carry it forward marked stale instead of showing a hole in the tape.
    const merged = rows.map((row) => {
      if (row.cashLastUsd !== null) return row;
      const prior = cache?.data.find((r) => r.symbol === row.symbol);
      if (prior?.cashLastUsd != null) {
        return { ...row, cashLastUsd: prior.cashLastUsd, cashAsOfMs: prior.cashAsOfMs, cashStale: true };
      }
      return row;
    });

    cache = { data: merged, fetchedAt: now };
    return { rows: merged, fetchedAt: now, session: getSessionInfo() };
  } catch (err) {
    if (cache) {
      return {
        rows: cache.data.map((r) => ({ ...r, cashStale: true })),
        fetchedAt: cache.fetchedAt,
        session: getSessionInfo(),
        error: 'live fetch failed, showing last known values',
      };
    }
    throw err;
  }
}
