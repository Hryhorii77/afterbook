import { STOCKS } from './tokens';
import { getSessionInfo, type SessionInfo } from './marketClock';
import { midPriceUsd, poolDepth, readPoolState, MULTIPLIER_ONE } from './quote';
import { recordSample } from './history';
import { recordPriceSample } from './volatility';
import { checkMultiplierChange } from './corporateActions';
import { getNextEarnings } from './earningsCalendar';
import { sendTelegramMessage } from './telegram';

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
  /** B20 multiplier as a plain ratio (1.0 = no-op). Not split-only — Base's
   *  own B20 spec has cash dividends reinvested by raising this too, net of
   *  withholding tax and a Coinbase fee. All ten read exactly 1.0 today. */
  multiplier: number | null;
  /** ISO date (YYYY-MM-DD) of the next known earnings report for this
   *  symbol's cash ticker, or null if none is on file (expected for a
   *  thin-history name like SPCX). From lib/earningsCalendar.ts. */
  nextEarningsDate: string | null;
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
// between /api/tape and the share card route (app/card/route.tsx) so both reuse the same
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

/** The newest trade after `afterSec` in Yahoo's minute bars (extended hours included), or null.
 *  Only trades from the last 4 hours count: an after-hours session lasts 4 hours, and 8 hours separate
 *  it from the next pre-market, so early pre-market never relabels last night's trade as today's. */
const EXTENDED_BAR_MAX_AGE_SEC = 4 * 60 * 60;
export function lastBarAfter(result: unknown, afterSec: number, nowSec = Date.now() / 1000): { price: number; asOfMs: number } | null {
  afterSec = Math.max(afterSec, nowSec - EXTENDED_BAR_MAX_AGE_SEC);
  const r = result as { timestamp?: unknown; indicators?: { quote?: { close?: unknown }[] } } | undefined;
  const ts = Array.isArray(r?.timestamp) ? (r.timestamp as unknown[]) : [];
  const closes = Array.isArray(r?.indicators?.quote?.[0]?.close) ? (r.indicators.quote[0].close as unknown[]) : [];
  for (let i = Math.min(ts.length, closes.length) - 1; i >= 0; i--) {
    const t = ts[i];
    const c = closes[i];
    if (typeof t !== 'number' || t <= afterSec) return null;
    if (typeof c === 'number' && c > 0) return { price: c, asOfMs: t * 1000 };
  }
  return null;
}

// `extended` (pre-market or after-hours by the app's own clock): ask for today's minute bars with
// extended hours too. Since about October 2026 Yahoo's chart meta no longer carries
// preMarketPrice/postMarketPrice, so the tape compared after-hours onchain prices with the 4pm close
// and showed an earnings move as a gap (GOOGL 2026-10-28: -1,025 bp against $324.89 while it traded
// $288 after hours). The newest bar after the regular close is the live extended-hours print.
async function fetchCashPrice(ticker: string, extended = false): Promise<CashPrice | null> {
  const query = extended ? 'interval=1m&range=1d&includePrePost=true' : 'interval=1d&range=1d';
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${ticker}?${query}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfterbookTape/1.0)' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const asOf = meta?.regularMarketTime;
      if (typeof price === 'number' && typeof asOf === 'number') {
        let preMarketPrice = numOrNull(meta?.preMarketPrice);
        let preMarketTime = numOrNull(meta?.preMarketTime);
        let postMarketPrice = numOrNull(meta?.postMarketPrice);
        let postMarketTime = numOrNull(meta?.postMarketTime);
        // Meta fields first (if Yahoo brings them back); else the newest bar after the last close.
        // Which of the two it is (pre or post) is decided by buildTape from the session clock.
        const bar = extended ? lastBarAfter(json?.chart?.result?.[0], asOf) : null;
        if (bar && preMarketPrice == null) [preMarketPrice, preMarketTime] = [bar.price, bar.asOfMs / 1000];
        if (bar && postMarketPrice == null) [postMarketPrice, postMarketTime] = [bar.price, bar.asOfMs / 1000];
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
        fetchCashPrice(stock.cashTicker, sessionState === 'pre-market' || sessionState === 'after-hours'),
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

      // Not gated on liquidity — a real split or dividend, and an upcoming
      // earnings date, matter for a thin pool exactly as much as a deep one.
      if (poolState) {
        void checkMultiplierChange(stock.symbol, poolState.multiplier, Date.now()).then((change) => {
          if (!change) return;
          const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
          if (!adminChatId) return;
          void sendTelegramMessage(
            adminChatId,
            `${stock.symbol} multiplier changed ${change.from.toFixed(4)}x → ${change.to.toFixed(4)}x — likely a dividend reinvestment or split. Verify on-chain.`,
          );
        });
      }
      const nextEarningsDate = await getNextEarnings(stock.symbol);

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
        multiplier: poolState ? Number(poolState.multiplier) / MULTIPLIER_ONE : null,
        nextEarningsDate,
      };
    }),
  );
  return rows;
}

/** Writes this tape's gap and Aero price history samples. Called only by the 5-minute alerts cron,
 *  so it is one write per stock per 5 minutes however many serverless instances are warm (each
 *  instance sampling on its own traffic used up the Upstash monthly request cap on 2026-10-18).
 *  Not gated on liquidity: a thin pool's gap swings more, and its history matters as much. */
export async function recordTapeSamples(rows: TapeRow[], now = Date.now()): Promise<void> {
  await Promise.all(
    rows.flatMap((r) => [recordSample(r.symbol, r.cashStale ? null : r.basisBp, now), recordPriceSample(r.symbol, r.onchainMidUsd, now)]),
  );
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
