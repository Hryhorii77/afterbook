import type { CbStock } from './tokens';
import { getClient, midPriceUsd, priceFromSqrtX96, type PoolState } from './quote';

// Slipstream (Aerodrome's CL fork) is a Uniswap V3 fork, so tickBitmap/ticks
// carry the same storage layout and semantics as upstream V3 — verified
// against the same custom-factory pools lib/quote.ts already reads
// slot0()/liquidity() from.
const TICK_BITMAP_ABI = [
  {
    type: 'function',
    name: 'tickBitmap',
    stateMutability: 'view',
    inputs: [{ name: 'wordPosition', type: 'int16' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const TICKS_ABI = [
  {
    type: 'function',
    name: 'ticks',
    stateMutability: 'view',
    inputs: [{ name: 'tick', type: 'int24' }],
    outputs: [
      { name: 'liquidityGross', type: 'uint128' },
      { name: 'liquidityNet', type: 'int128' },
      { name: 'feeGrowthOutside0X128', type: 'uint256' },
      { name: 'feeGrowthOutside1X128', type: 'uint256' },
      { name: 'tickCumulativeOutside', type: 'int56' },
      { name: 'secondsPerLiquidityOutsideX128', type: 'uint160' },
      { name: 'secondsOutside', type: 'uint32' },
      { name: 'initialized', type: 'bool' },
    ],
  },
] as const;

// How wide a price window to scan around the current tick. Wide enough to
// show real LPs where support/resistance walls sit, narrow enough that the
// word/tick scan stays a handful of multicalls — see wordsForRange below.
const PRICE_RANGE_PCT = 0.25;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

// Uniswap V3's TickBitmap.position(), re-derived with floor division instead
// of Solidity's bitwise int16(tick >> 8) / uint8(tick % 256): for a signed
// dividend, floor-div/floor-mod and Solidity's arithmetic-shift/wrapped-mod
// are the same operation, and floor division is unambiguous in JS (no
// two's-complement cast semantics to replicate by hand).
function wordPositionOf(compressedTick: number): number {
  return Math.floor(compressedTick / 256);
}

export interface LiquidityBucket {
  tickLower: number;
  tickUpper: number;
  priceLowerUsd: number;
  priceUpperUsd: number;
  /** Active liquidity across [tickLower, tickUpper), as a decimal string
   *  (can exceed Number precision for very deep pools). */
  liquidity: string;
}

export interface LiquidityDistribution {
  currentTick: number;
  currentPriceUsd: number;
  buckets: LiquidityBucket[];
}

/**
 * Reconstructs active liquidity across a price window around the pool's
 * current tick, from the same on-chain tick-bitmap/ticks data Uniswap V3
 * style UIs use — no subgraph, no third-party indexer. Rendering-only: a
 * dropped or failed read degrades to treating that tick as uncrossed
 * (liquidityNet 0) rather than throwing, since a slightly-off histogram bar
 * is fine but a dead Lot Lab panel isn't.
 */
export async function getLiquidityDistribution(stock: CbStock, state: PoolState): Promise<LiquidityDistribution> {
  const client = getClient();
  const spacing = stock.pool.tickSpacing;
  const currentTick = state.tick;
  const currentPriceUsd = midPriceUsd(state, stock);

  const tickDelta = Math.round(Math.log(1 + PRICE_RANGE_PCT) / Math.log(1.0001));
  const minTick = Math.max(MIN_TICK, currentTick - tickDelta);
  const maxTick = Math.min(MAX_TICK, currentTick + tickDelta);
  const minCompressed = Math.floor(minTick / spacing);
  const maxCompressed = Math.floor(maxTick / spacing);

  const minWord = wordPositionOf(minCompressed);
  const maxWord = wordPositionOf(maxCompressed);
  const words: number[] = [];
  for (let w = minWord; w <= maxWord; w++) words.push(w);

  const bitmapResults = await client.multicall({
    contracts: words.map((w) => ({ address: stock.pool.address, abi: TICK_BITMAP_ABI, functionName: 'tickBitmap', args: [w] })),
    allowFailure: true,
  });

  const initializedTicks: number[] = [];
  words.forEach((wordPos, i) => {
    const result = bitmapResults[i];
    if (result.status !== 'success') return;
    const word = result.result as bigint;
    if (word === 0n) return;
    for (let bitPos = 0; bitPos < 256; bitPos++) {
      if ((word >> BigInt(bitPos)) & 1n) {
        const compressed = wordPos * 256 + bitPos;
        if (compressed < minCompressed || compressed > maxCompressed) continue;
        initializedTicks.push(compressed * spacing);
      }
    }
  });
  initializedTicks.sort((a, b) => a - b);

  const netByTick = new Map<number, bigint>();
  if (initializedTicks.length > 0) {
    const ticksResults = await client.multicall({
      contracts: initializedTicks.map((tick) => ({ address: stock.pool.address, abi: TICKS_ABI, functionName: 'ticks', args: [tick] })),
      allowFailure: true,
    });
    initializedTicks.forEach((tick, i) => {
      const result = ticksResults[i];
      if (result.status !== 'success') return;
      const [, liquidityNet] = result.result as readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean];
      netByTick.set(tick, liquidityNet);
    });
  }

  // Synthetic, non-crossing edges at the scan window's bounds — give the
  // outermost buckets a rendering edge without implying a real liquidity
  // event happens exactly there.
  const edgeTicks = [minTick, ...initializedTicks.filter((t) => t > minTick && t < maxTick), maxTick];

  const currentIdx = (() => {
    let idx = 0;
    for (let i = 0; i < edgeTicks.length; i++) {
      if (edgeTicks[i] <= currentTick) idx = i;
    }
    return Math.min(idx, edgeTicks.length - 2);
  })();

  const liquidityAt = new Array<bigint>(edgeTicks.length - 1);
  liquidityAt[currentIdx] = state.liquidity;
  for (let i = currentIdx + 1; i < liquidityAt.length; i++) {
    const net = netByTick.get(edgeTicks[i]) ?? 0n;
    const next = liquidityAt[i - 1] + net;
    liquidityAt[i] = next < 0n ? 0n : next;
  }
  for (let i = currentIdx - 1; i >= 0; i--) {
    const net = netByTick.get(edgeTicks[i + 1]) ?? 0n;
    const prev = liquidityAt[i + 1] - net;
    liquidityAt[i] = prev < 0n ? 0n : prev;
  }

  const buckets: LiquidityBucket[] = [];
  for (let i = 0; i < liquidityAt.length; i++) {
    const tickLower = edgeTicks[i];
    const tickUpper = edgeTicks[i + 1];
    // token0 is USDC for every pool here (lib/tokens.ts), so USD price
    // *decreases* as tick increases (same direction lib/quote.ts's
    // priceFromSqrtX96 uses) — priceLowerUsd is therefore the price at
    // tickUpper, not tickLower. Intentional, not a copy-paste swap.
    buckets.push({
      tickLower,
      tickUpper,
      priceLowerUsd: priceFromSqrtX96(sqrtPriceX96FromTick(tickUpper), state.multiplier, stock),
      priceUpperUsd: priceFromSqrtX96(sqrtPriceX96FromTick(tickLower), state.multiplier, stock),
      liquidity: liquidityAt[i].toString(),
    });
  }

  return { currentTick, currentPriceUsd, buckets };
}

const Q96 = 2 ** 96;

// Forward direction of lib/quote.ts's tickForPriceUsd — needed here only to
// turn a tick edge back into a sqrtPriceX96 so priceFromSqrtX96 can do the
// decimals/multiplier adjustment consistently in one place.
function sqrtPriceX96FromTick(tick: number): bigint {
  const sqrtP = Math.sqrt(1.0001 ** tick);
  return BigInt(Math.round(sqrtP * Q96));
}
