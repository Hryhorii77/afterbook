import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { USDC, type CbStock } from './tokens';

const POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'liquidity',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint128' }],
  },
] as const;

// The B20 asset standard (Coinbase's tokenized-equity token format) carries a
// `multiplier()` — a fixed-point (1e18 = 1.0x) scalar the issuer can change to
// reflect corporate actions like stock splits without migrating any holder's
// raw balance. All four stocks read 1e18 today (verified on-chain), but since
// this is exactly the lever a split would pull, we read it live on every
// quote instead of assuming 1.0 forever — otherwise "shares out" would
// silently become wrong the day it changes.
const TOKEN_ABI = [
  {
    type: 'function',
    name: 'multiplier',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const MULTIPLIER_ONE = 10 ** 18;

let client: PublicClient | null = null;

// https://mainnet.base.org is Base's own documented official RPC endpoint
// (docs.base.org/get-started/connect-to-base). base-rpc.publicnode.com is a
// fallback only — mainnet.base.org has been observed rate-limiting *heavy,
// sustained* scan workloads (building aero-allocator against the same
// endpoint), but Afterbook's load is a handful of cached multicalls every
// 20s, well within what the official endpoint handles fine.
export function getClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: base,
      transport: fallback([http('https://mainnet.base.org'), http('https://base-rpc.publicnode.com')]),
    }) as PublicClient;
  }
  return client;
}

export interface PoolState {
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** B20 multiplier, fixed-point 1e18 = 1.0x. Falls back to 1e18 (no-op) if
   *  the token doesn't implement multiplier() at all. */
  multiplier: bigint;
  /** Real reserves — token.balanceOf(pool), raw units. These are the actual
   *  deployed tokens, distinct from (and much smaller than) the virtual
   *  reserves used for impact math above, which describe in-range liquidity
   *  depth, not literal holdings. Use these for a "how deep is this pool,
   *  really" display, not the virtual ones. */
  usdcReserveRaw: bigint;
  stockReserveRaw: bigint;
}

export async function readPoolState(stock: CbStock, publicClient: PublicClient = getClient()): Promise<PoolState> {
  const [slot0, liquidity, multiplierResult, usdcReserve, stockReserve] = await publicClient.multicall({
    contracts: [
      { address: stock.pool.address, abi: POOL_ABI, functionName: 'slot0' },
      { address: stock.pool.address, abi: POOL_ABI, functionName: 'liquidity' },
      { address: stock.tokenAddress, abi: TOKEN_ABI, functionName: 'multiplier' },
      { address: USDC.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [stock.pool.address] },
      { address: stock.tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [stock.pool.address] },
    ],
    allowFailure: true,
  });

  if (slot0.status !== 'success' || liquidity.status !== 'success') {
    throw new Error(`pool state read failed for ${stock.symbol}`);
  }

  const [sqrtPriceX96] = slot0.result as readonly [bigint, number, number, number, number, boolean];
  const multiplier = multiplierResult.status === 'success' ? (multiplierResult.result as bigint) : BigInt(MULTIPLIER_ONE);
  return {
    sqrtPriceX96,
    liquidity: liquidity.result as bigint,
    multiplier,
    usdcReserveRaw: usdcReserve.status === 'success' ? (usdcReserve.result as bigint) : 0n,
    stockReserveRaw: stockReserve.status === 'success' ? (stockReserve.result as bigint) : 0n,
  };
}

const Q96 = 2 ** 96;

/**
 * USD price of one *displayed* share, derived from the pool's current
 * sqrtPriceX96 and adjusted for the token's B20 multiplier. token0 is USDC
 * for every pool in lib/tokens.ts (verified on-chain), so this direction is
 * fixed across all four stocks.
 */
export function midPriceUsd(state: PoolState, stock: CbStock): number {
  const sqrtP = Number(state.sqrtPriceX96) / Q96;
  const rawToken1PerToken0 = sqrtP * sqrtP; // stock-raw-units per USDC-raw-unit
  const decAdjusted = rawToken1PerToken0 * 10 ** (USDC.decimals - stock.decimals); // stock per USDC
  const rawMidPriceUsd = 1 / decAdjusted; // USD per raw token unit
  const multiplierRatio = Number(state.multiplier) / MULTIPLIER_ONE;
  return rawMidPriceUsd / multiplierRatio; // USD per displayed share
}

export interface PoolDepth {
  usdcUsd: number;
  stockShares: number;
  totalUsd: number;
}

/** Real pool depth from actual token balances, not the virtual reserves
 *  estimateLot uses for impact math. */
export function poolDepth(state: PoolState, stock: CbStock): PoolDepth {
  const usdcUsd = Number(state.usdcReserveRaw) / 10 ** USDC.decimals;
  const multiplierRatio = Number(state.multiplier) / MULTIPLIER_ONE;
  const stockShares = (Number(state.stockReserveRaw) / 10 ** stock.decimals) * multiplierRatio;
  const totalUsd = usdcUsd + stockShares * midPriceUsd(state, stock);
  return { usdcUsd, stockShares, totalUsd };
}

export interface LotEstimate {
  usdcIn: number;
  sharesOut: number;
  midPriceUsd: number;
  execPriceUsd: number;
  impactBp: number;
  feeBp: number;
  /** true when the trade is large enough relative to in-range liquidity that
   *  it likely crosses into a different tick range, where this constant-
   *  liquidity estimate stops being exact. */
  largeTradeCaveat: boolean;
}

/**
 * Price-impact estimate for an exact-input USDC->share swap.
 *
 * Aerodrome's documented public Quoter/SwapRouter are bound to a different CL
 * factory than the one these stock pools were deployed through (verified
 * on-chain: pool.factory() != quoter.factory()), so calling the standard
 * Quoter reverts. Instead we read slot0()/liquidity() ourselves and use the
 * fact that a concentrated-liquidity pool behaves *exactly* like a
 * constant-product pool with virtual reserves (L/sqrtP, L*sqrtP) as long as
 * the trade doesn't cross out of the current tick's liquidity. That's exact
 * math, not a guess — but it stops being exact once a trade is large enough
 * to walk into the next tick range, which is what largeTradeCaveat flags.
 *
 * This is intentionally an estimate for sizing a trade, not a quote to
 * execute against — the actual swap always happens on Aerodrome's own app.
 */
export function estimateLot(state: PoolState, stock: CbStock, usdcIn: number): LotEstimate {
  const sqrtP = Number(state.sqrtPriceX96) / Q96;
  const L = Number(state.liquidity);

  const virtualReserve0Raw = L / sqrtP; // USDC raw units (6dp)
  const virtualReserve1Raw = L * sqrtP; // stock raw units (8dp)

  const feeBp = (stock.pool.feePpm / 1_000_000) * 10_000; // ppm -> bp
  const usdcInRaw = usdcIn * 10 ** USDC.decimals;
  const usdcInRawAfterFee = usdcInRaw * (1 - stock.pool.feePpm / 1_000_000);

  const sharesOutRaw = (virtualReserve1Raw * usdcInRawAfterFee) / (virtualReserve0Raw + usdcInRawAfterFee);
  const multiplierRatio = Number(state.multiplier) / MULTIPLIER_ONE;
  const sharesOut = (sharesOutRaw / 10 ** stock.decimals) * multiplierRatio;

  const mid = midPriceUsd(state, stock);
  const execPrice = sharesOut > 0 ? usdcIn / sharesOut : mid;
  const impactBp = mid > 0 ? ((execPrice - mid) / mid) * 10_000 : 0;

  return {
    usdcIn,
    sharesOut,
    midPriceUsd: mid,
    execPriceUsd: execPrice,
    impactBp,
    feeBp,
    largeTradeCaveat: usdcInRawAfterFee > virtualReserve0Raw * 0.15,
  };
}

// Fixed log-spaced sizes for the impact curve — same points for every stock
// so pools can be compared at a glance.
export const CURVE_SIZES_USDC = [500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

export interface CurvePoint {
  usdcIn: number;
  impactBp: number;
  sharesOut: number;
  largeTradeCaveat: boolean;
}

/**
 * Impact at a spread of trade sizes, reusing a single already-fetched
 * PoolState — this is pure CPU work, no extra RPC calls, since estimateLot's
 * virtual-reserve math is cheap to re-run per size.
 */
export function buildImpactCurve(state: PoolState, stock: CbStock, sizes: number[] = CURVE_SIZES_USDC): CurvePoint[] {
  return sizes.map((usdcIn) => {
    const { impactBp, sharesOut, largeTradeCaveat } = estimateLot(state, stock, usdcIn);
    return { usdcIn, impactBp, sharesOut, largeTradeCaveat };
  });
}
