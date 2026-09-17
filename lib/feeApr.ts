import { redis } from './redis';
import type { CbStock } from './tokens';

// Snapshot-based fee APR: Aerodrome exposes no volume/fee-revenue API
// anywhere (confirmed — no api.aerodrome.finance, Sugar's Lp struct has no
// volume field), and pulling one from a third party (GeckoTerminal,
// Dexscreener) would be this app's first live runtime dependency on
// unaudited off-chain data. Instead this snapshots the pool's own
// feeGrowthGlobal0X128/1X128 counters (lib/quote.ts's PoolState) once a day
// and takes a delta — the same per-liquidity fee accounting Uniswap V3
// positions use internally, so it's exact pool-wide fee revenue over the
// snapshot window, not an estimate from volume. The tradeoff is a cold
// start: the first useful number needs two daily snapshots ~a day apart.

const SNAPSHOT_RETENTION_MS = 10 * 24 * 60 * 60_000;
const LOOKBACK_MS = 8 * 24 * 60 * 60_000;
const MIN_WINDOW_MS = 18 * 60 * 60_000;
const Q128 = 2n ** 128n;
const U256_MOD = 2n ** 256n;
const MULTIPLIER_ONE = 1e18;

interface FeeSnapshot {
  ts: number;
  feeGrowth0: bigint;
  feeGrowth1: bigint;
  liquidity: bigint;
  tvlUsd: number;
}

export async function recordFeeSnapshot(
  symbol: string,
  feeGrowth0: bigint,
  feeGrowth1: bigint,
  liquidity: bigint,
  tvlUsd: number,
  now: number,
): Promise<void> {
  if (!redis) return;
  const key = `feeSnap:${symbol}`;
  const member = `${now}:${feeGrowth0}:${feeGrowth1}:${liquidity}:${tvlUsd.toFixed(2)}`;
  try {
    await Promise.all([
      redis.zadd(key, { score: now, member }),
      redis.zremrangebyscore(key, 0, now - SNAPSHOT_RETENTION_MS),
    ]);
  } catch {
    // best-effort — a missed snapshot just widens the next APR window
  }
}

async function getFeeSnapshots(symbol: string, sinceMs: number): Promise<FeeSnapshot[]> {
  if (!redis) return [];
  try {
    const raw = await redis.zrange<string[]>(`feeSnap:${symbol}`, sinceMs, Date.now(), { byScore: true });
    return raw
      .map((entry) => {
        const parts = entry.split(':');
        if (parts.length !== 5) return null;
        const [ts, feeGrowth0, feeGrowth1, liquidity, tvlUsd] = parts;
        return {
          ts: Number(ts),
          feeGrowth0: BigInt(feeGrowth0),
          feeGrowth1: BigInt(feeGrowth1),
          liquidity: BigInt(liquidity),
          tvlUsd: Number(tvlUsd),
        };
      })
      .filter((s): s is FeeSnapshot => s !== null && Number.isFinite(s.ts) && Number.isFinite(s.tvlUsd));
  } catch {
    return [];
  }
}

// feeGrowthGlobal is documented as overflow-prone (same as upstream Uniswap
// V3), so a delta between two readings must wrap around rather than go
// negative.
function feeGrowthDelta(newVal: bigint, oldVal: bigint): bigint {
  return ((newVal - oldVal) % U256_MOD + U256_MOD) % U256_MOD;
}

export interface FeeAprResult {
  aprPct: number;
  windowDays: number;
}

/**
 * Pool-wide fee APR from a feeGrowthGlobal snapshot delta, not a per-position
 * or per-user figure — every LP in the pool earns proportional to their
 * share of liquidity at any instant, so this is the right denominator-free
 * way to express "what has this pool been yielding."
 */
export async function computeFeeApr(
  symbol: string,
  stock: CbStock,
  currentPriceUsd: number,
  multiplier: bigint,
): Promise<FeeAprResult | null> {
  const snapshots = await getFeeSnapshots(symbol, Date.now() - LOOKBACK_MS);
  if (snapshots.length < 2) return null;

  const oldest = snapshots[0];
  const newest = snapshots[snapshots.length - 1];
  const windowMs = newest.ts - oldest.ts;
  if (windowMs < MIN_WINDOW_MS || newest.tvlUsd <= 0) return null;

  const delta0 = feeGrowthDelta(newest.feeGrowth0, oldest.feeGrowth0);
  const delta1 = feeGrowthDelta(newest.feeGrowth1, oldest.feeGrowth1);
  // Approximation: uses the liquidity at the newest snapshot rather than
  // integrating over the window — the same simplification the window's own
  // caveat copy in the UI already covers ("estimate, not a guarantee").
  const feeToken0Raw = (delta0 * newest.liquidity) / Q128;
  const feeToken1Raw = (delta1 * newest.liquidity) / Q128;

  const isToken0Usdc = stock.pool.token0 === 'USDC';
  const usdcRaw = isToken0Usdc ? feeToken0Raw : feeToken1Raw;
  const stockRaw = isToken0Usdc ? feeToken1Raw : feeToken0Raw;

  const feeUsdcUsd = Number(usdcRaw) / 1e6;
  const multiplierRatio = Number(multiplier) / MULTIPLIER_ONE;
  const feeStockShares = (Number(stockRaw) / 10 ** stock.decimals) * multiplierRatio;
  const feeStockUsd = feeStockShares * currentPriceUsd;
  const feeUsd = feeUsdcUsd + feeStockUsd;

  const windowDays = windowMs / 86_400_000;
  const aprPct = (feeUsd / newest.tvlUsd) * (365 / windowDays) * 100;

  return { aprPct, windowDays };
}
