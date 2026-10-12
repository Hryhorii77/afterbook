import { redis } from './redis';
import type { CbStock } from './tokens';
import { getClient } from './quote';
import { fullRangeAprPct } from './lpRange';

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
  /** Fee APR of an unstaked, full-range position. A range's APR is this
   *  times its capital efficiency (lib/lpRange.ts rangeAprPct). */
  fullRangeAprPct: number;
  windowDays: number;
}

/**
 * Fees per unit of liquidity, from a feeGrowthGlobal snapshot delta, turned
 * into the APR of an unstaked full-range position.
 *
 * feeGrowthGlobal is what one unit of unstaked in-range liquidity earned:
 * Slipstream sends staked liquidity's share of each swap fee to the gauge
 * and takes its `unstakedFee` cut (10% on these pools) before crediting the
 * rest per unit of liquidity, so the delta needs no liquidity or TVL figure
 * at all. Checked 2026-10-12 against ~960 real swaps on NVDAc/AAPLc/METAc:
 * the delta came out at fee/L less 10–17%, matching that cut.
 *
 * This replaced "delta x the newest snapshot's active liquidity / pool TVL":
 * active liquidity swung 3–20x between daily snapshots and up to 96% of it
 * is staked (earning emissions, not these fees), so that figure (298% for
 * NVDAc) mostly measured which moment the snapshot caught.
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
  if (windowMs < MIN_WINDOW_MS) return null;

  const delta0 = Number(feeGrowthDelta(newest.feeGrowth0, oldest.feeGrowth0)) / Number(Q128);
  const delta1 = Number(feeGrowthDelta(newest.feeGrowth1, oldest.feeGrowth1)) / Number(Q128);
  const isToken0Usdc = stock.pool.token0 === 'USDC';
  const usdcPerL = (isToken0Usdc ? delta0 : delta1) / 1e6;
  const multiplierRatio = Number(multiplier) / MULTIPLIER_ONE;
  const stockUsdPerL = ((isToken0Usdc ? delta1 : delta0) / 10 ** stock.decimals) * multiplierRatio * currentPriceUsd;

  const windowDays = windowMs / 86_400_000;
  const usdPerLPerYear = (usdcPerL + stockUsdPerL) * (365 / windowDays);
  return { fullRangeAprPct: fullRangeAprPct(usdPerLPerYear, currentPriceUsd, stock.decimals, multiplierRatio), windowDays };
}

const SWAP_EVENT = {
  type: 'event',
  name: 'Swap',
  inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'amount0', type: 'int256', indexed: false },
    { name: 'amount1', type: 'int256', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ],
} as const;

// mainnet.base.org (and most public Base RPCs) cap eth_getLogs at a
// 2,000-block range — confirmed live against a real pool (error: "eth_getLogs
// is limited to a 2,000 range"). At Base's current ~2s block time that's a
// bit under 1.1 hours, so this samples the most recent ~1900 blocks (a
// safety margin under the cap, since "latest" can advance between the
// block-number read and the getLogs call) and annualizes that window's fee per
// unit of liquidity. Deliberately a much
// noisier, single-hour-sample estimate than computeFeeApr's multi-day
// feeGrowthGlobal delta above — this exists only to replace "collecting
// data" with *something* for a fresh deploy or a newly-thin pool, not to
// match that method's precision. Confirmed live that Slipstream pools emit
// the standard Uniswap V3 Swap event signature (topic0 0xc42079f9...ca6,
// verified against a real NVDAc pool log).
const LOG_RANGE_BLOCKS = 1900n;

const UNSTAKED_FEE_ABI = [{ type: 'function', name: 'unstakedFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] }] as const;

export async function estimateFeeAprFromRecentSwaps(stock: CbStock, currentPriceUsd: number, multiplier: bigint): Promise<FeeAprResult | null> {
  const client = getClient();
  try {
    const toBlock = await client.getBlockNumber();
    const fromBlock = toBlock > LOG_RANGE_BLOCKS ? toBlock - LOG_RANGE_BLOCKS : 0n;

    const [logs, fromBlockInfo, toBlockInfo, unstakedFeePpm] = await Promise.all([
      client.getLogs({ address: stock.pool.address as `0x${string}`, event: SWAP_EVENT, fromBlock, toBlock }),
      client.getBlock({ blockNumber: fromBlock }),
      client.getBlock({ blockNumber: toBlock }),
      client.readContract({ address: stock.pool.address, abi: UNSTAKED_FEE_ABI, functionName: 'unstakedFee' }),
    ]);
    if (logs.length === 0) return null;

    const windowMs = Number(toBlockInfo.timestamp - fromBlockInfo.timestamp) * 1000;
    if (windowMs <= 0) return null;

    // Same per-unit-of-liquidity quantity computeFeeApr reads off
    // feeGrowthGlobal, rebuilt swap by swap: the fee is charged on the input
    // side (the positive amount), less the unstaked cut, over the liquidity
    // the event reports. Approximate for a swap that crosses ticks.
    const isToken0Usdc = stock.pool.token0 === 'USDC';
    const multiplierRatio = Number(multiplier) / MULTIPLIER_ONE;
    const keep = 1 - Number(unstakedFeePpm) / 1_000_000;
    let usdPerL = 0;
    for (const log of logs) {
      const amount0 = (log.args.amount0 as bigint | undefined) ?? 0n;
      const amount1 = (log.args.amount1 as bigint | undefined) ?? 0n;
      const liquidity = Number((log.args.liquidity as bigint | undefined) ?? 0n);
      if (liquidity <= 0) continue;
      const usdcIn = isToken0Usdc ? amount0 : amount1;
      const stockIn = isToken0Usdc ? amount1 : amount0;
      const inUsd =
        usdcIn > 0n ? Number(usdcIn) / 1e6 : stockIn > 0n ? (Number(stockIn) / 10 ** stock.decimals) * multiplierRatio * currentPriceUsd : 0;
      usdPerL += (inUsd * (stock.pool.feePpm / 1_000_000) * keep) / liquidity;
    }

    const windowDays = windowMs / 86_400_000;
    return { fullRangeAprPct: fullRangeAprPct(usdPerL * (365 / windowDays), currentPriceUsd, stock.decimals, multiplierRatio), windowDays };
  } catch {
    // Best-effort — a cold-start caller falls back further to null (the UI's
    // existing "collecting data" copy), not a thrown error.
    return null;
  }
}

export interface FeeAprWithFallback extends FeeAprResult {
  /** true when this came from the getLogs cold-start fallback rather than
   *  the real feeGrowthGlobal snapshot delta — callers should caveat
   *  accordingly rather than presenting it with the same confidence. */
  estimated: boolean;
}

/** Tries the real snapshot-delta method first; only falls back to the
 *  noisier recent-swaps estimate when there isn't enough snapshot history
 *  yet (a fresh deploy, or a pool that only recently became worth tracking). */
export async function computeFeeAprWithFallback(
  symbol: string,
  stock: CbStock,
  currentPriceUsd: number,
  multiplier: bigint,
): Promise<FeeAprWithFallback | null> {
  const real = await computeFeeApr(symbol, stock, currentPriceUsd, multiplier);
  if (real) return { ...real, estimated: false };

  const estimate = await estimateFeeAprFromRecentSwaps(stock, currentPriceUsd, multiplier);
  return estimate ? { ...estimate, estimated: true } : null;
}
