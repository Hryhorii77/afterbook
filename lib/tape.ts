import { STOCKS } from './tokens';
import { getSessionInfo, type SessionInfo } from './marketClock';
import { midPriceUsd, poolDepth, readPoolState } from './quote';
import { isLiquid } from './liquidity';
import { recordSample } from './history';

const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const CACHE_TTL_MS = 20_000;

export interface TapeRow {
  symbol: string;
  cashTicker: string;
  name: string;
  /** Best available live cash reference: the regular-session price,
   *  unless the market is in pre-market/after-hours and Yahoo returned a
   *  live extended-hours print, in which case that's used instead. This
   *  is what basisBp is computed against. */
  cashLastUsd: number | null;
  /** Epoch ms of whichever price cashLastUsd holds. */
  cashAsOfMs: number | null;
  /** Which price cashLastUsd actually is — drives the "Cash close" vs
   *  "Cash pre-market"/"Cash after-hours" column label. */
  cashPriceType: 'regular' | 'pre-market' | 'after-hours';
  cashStale: boolean;
  /** Always the regular-session close, regardless of cashPriceType —
   *  unlike cashLastUsd, this never becomes a pre/post-market price.
   *  Gap-hero's "closed Xh Ym ago" duration and its "$X -> $Y" per-card
   *  move are both anchored to this, not to whatever cashLastUsd is
   *  currently showing. */
  closeUsd: number | null;
  /** Epoch ms of the regular-session close instant (verified:
   *  regularMarketTime == currentTradingPeriod.regular.end when the
   *  market isn't live), which is what makes the "closed since" gap math
   *  exact. */
  closeAsOfMs: number | null;
  onchainMidUsd: number | null;
  /** Current pool tick, straight off slot0() — carried through so LP-position
   *  helpers (lib/lots.ts) can tell whether a position is in range without a
   *  second RPC call. */
  tick: number | null;
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
  /** Live extended-hours prints, when Yahoo has them — same response as
   *  the regular fields above, just two more fields off the same fetch.
   *  Only trusted when the app's own session clock says we're actually
   *  in that window (see buildTape) — not gated on Yahoo's own
   *  marketState, so all ten rows stay consistent with each other and
   *  with the rest of the page rather than each ticker's feed lag. */
  preMarketPrice: number | null;
  preMarketAsOfMs: number | null;
  postMarketPrice: number | null;
  postMarketAsOfMs: number | null;
}

function numOrNull(x: unknown): number | null {
  return typeof x === 'number' ? x : null;
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
        const preMarketPrice = numOrNull(meta?.preMarketPrice);
        const preMarketTime = numOrNull(meta?.preMarketTime);
        const postMarketPrice = numOrNull(meta?.postMarketPrice);
        const postMarketTime = numOrNull(meta?.postMarketTime);
        return {
          price,
          asOfMs: asOf * 1000,
          preMarketPrice,
          preMarketAsOfMs: preMarketPrice != null && preMarketTime != null ? preMarketTime * 1000 : null,
          postMarketPrice,
          postMarketAsOfMs: postMarketPrice != null && postMarketTime != null ? postMarketTime * 1000 : null,
        };
      }
    } catch {
      // try next host
    }
  }
  return null;
}

async function buildTape(): Promise<TapeRow[]> {
  // One session read for the whole build — every row uses the same
  // pre-market/after-hours determination, so the tape can't show some
  // rows on the live extended-hours print and others still on yesterday's
  // close depending on per-ticker Yahoo feed lag.
  const sessionState = getSessionInfo().state;

  const rows = await Promise.all(
    STOCKS.map(async (stock): Promise<TapeRow> => {
      const [cash, poolState] = await Promise.all([
        fetchCashPrice(stock.cashTicker),
        readPoolState(stock).catch(() => null),
      ]);

      let cashRefUsd = cash?.price ?? null;
      let cashRefAsOfMs = cash?.asOfMs ?? null;
      let cashPriceType: TapeRow['cashPriceType'] = 'regular';
      if (sessionState === 'pre-market' && cash?.preMarketPrice != null) {
        cashRefUsd = cash.preMarketPrice;
        cashRefAsOfMs = cash.preMarketAsOfMs;
        cashPriceType = 'pre-market';
      } else if (sessionState === 'after-hours' && cash?.postMarketPrice != null) {
        cashRefUsd = cash.postMarketPrice;
        cashRefAsOfMs = cash.postMarketAsOfMs;
        cashPriceType = 'after-hours';
      }

      const onchainMid = poolState ? midPriceUsd(poolState, stock) : null;
      const basisBp =
        cashRefUsd !== null && onchainMid !== null ? ((onchainMid - cashRefUsd) / cashRefUsd) * 10_000 : null;
      const depth = poolState ? poolDepth(poolState, stock) : null;
      const depthUsd = depth?.totalUsd ?? null;

      if (isLiquid({ depthUsd })) {
        void recordSample(stock.symbol, basisBp, Date.now());
      }

      return {
        symbol: stock.symbol,
        cashTicker: stock.cashTicker,
        name: stock.name,
        cashLastUsd: cashRefUsd,
        cashAsOfMs: cashRefAsOfMs,
        cashPriceType,
        cashStale: false,
        closeUsd: cash?.price ?? null,
        closeAsOfMs: cash?.asOfMs ?? null,
        onchainMidUsd: onchainMid,
        tick: poolState?.tick ?? null,
        basisBp,
        depthUsd,
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
        return {
          ...row,
          cashLastUsd: prior.cashLastUsd,
          cashAsOfMs: prior.cashAsOfMs,
          cashPriceType: prior.cashPriceType,
          closeUsd: prior.closeUsd,
          closeAsOfMs: prior.closeAsOfMs,
          cashStale: true,
        };
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
