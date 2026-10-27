import { getClient, TOKEN_ABI, ERC20_ABI, MULTIPLIER_ONE, priceFromSqrtX96, getCachedPoolState } from './quote';
import { STOCKS, CL_FACTORY, AERO_CL_FACTORY, AERO_POSITION_MANAGER, type CbStock } from './tokens';
import type { TapeRow } from './tape';
import { computeFeeAprWithFallback } from './feeApr';
import { rangeAprPct } from './lpRange';
import { getPriceHistory, computeInRangeProbabilityPct, IN_RANGE_HORIZON_DAYS } from './volatility';
import { getGaugeYield, getVotingIncentiveFlag } from './gaugeYield';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// AERO is a standard 18-decimal ERC20 — Sugar's emissions_earned is denominated
// in it. This app has no AERO/USDC pool tracked, so there's no price feed to
// convert it to USD; shown as a raw token amount instead of inventing one.
const AERO_DECIMALS = 18;

// LP positions are read from each CL factory's own position manager (Uniswap-v3 style NFTs), not
// Aerodrome's Sugar helper: since the Aero upgrade (2026-10-22) Sugar's positionsByFactory returns
// nothing for wallets that still hold live positions in these pools (checked 2026-10-27), and Aero
// has no Sugar at all. Both managers below report factory() = the factory named.
// Older Aerodrome factory (CL_FACTORY; read off the NFT minted with a 2026-10 NVDAc deposit): not the
// publicly documented 0x82792268 manager, which is
// bound to a different factory.
const AERODROME_POSITION_MANAGER = '0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53' as const;

/** One position, in the shape Sugar used to return (so the code below didn't change). */
interface LpPosition {
  id: bigint;
  lp: `0x${string}`;
  liquidity: bigint;
  staked: bigint;
  amount0: bigint;
  amount1: bigint;
  staked0: bigint;
  staked1: bigint;
  unstaked_earned0: bigint;
  unstaked_earned1: bigint;
  emissions_earned: bigint;
  tick_lower: number;
  tick_upper: number;
  sqrt_ratio_lower: bigint;
  sqrt_ratio_upper: bigint;
  locker: string;
  unlocks_at: number;
}

// At most this many positions per wallet and manager: well above what one wallet realistically
// holds across our stocks, but bounded rather than unbounded.
const POSITION_LIMIT = 50n;

// The pools the 12 original stocks were read from until 2026-10-27, when they moved to their Aero
// pools. Earlier "Add liquidity" links sent people here, so My Lots still shows positions in them
// (as the same stock, priced from that pool's own state). Display only: they are not in STOCKS, so
// nothing else (swaps, the tape, baskets) uses them.
const LEGACY_POOLS: [`0x${string}`, string][] = [
  ['0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9', 'NVDAc'],
  ['0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0', 'AAPLc'],
  ['0xEAF57753BC382E0324a1D43F72E7027705a2273E', 'METAc'],
  ['0xB1987CAD1682841b4b641d50E520777eC5Ab5542', 'GOOGLc'],
  ['0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b', 'AMZNc'],
  ['0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54', 'MSFTc'],
  ['0x8b27f626ab668197000BC722A1012022CAeD10E2', 'MSTRc'],
  ['0x5A8236f575471e7BfCA2C8462a200c28f737246E', 'SNDKc'],
  ['0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E', 'SPCXc'],
  ['0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB', 'TSLAc'],
  ['0x650cc267AA248191978013d5Ae421e5Dc2A6e242', 'PLTRc'],
  ['0x17e1bEB2cD65493Da73ed4BbbC7BEcAAa0F91C73', 'MUc'],
];
const LEGACY_STOCKS: CbStock[] = LEGACY_POOLS.flatMap(([address, symbol]) => {
  const stock = STOCKS.find((s) => s.symbol === symbol);
  return stock ? [{ ...stock, pool: { address, factory: CL_FACTORY, token0: 'USDC' as const, tickSpacing: 10, feePpm: 500 } }] : [];
});

/** The stock a position's pool belongs to: a tracked pool, or one of the old ones above. */
function stockForPool(pool: string): { stock: CbStock; legacy: boolean } | null {
  const p = pool.toLowerCase();
  const tracked = STOCKS.find((s) => s.pool.address.toLowerCase() === p);
  if (tracked) return { stock: tracked, legacy: false };
  const legacy = LEGACY_STOCKS.find((s) => s.pool.address.toLowerCase() === p);
  return legacy ? { stock: legacy, legacy: true } : null;
}

// ---- Positions ------------------------------------------------------------------------------------
// Read the plain Uniswap-v3 way: the wallet's own NFTs from the position manager, plus the ones it
// staked (held by each pool's gauge, gauge.stakedValues(wallet)). Amounts and uncollected fees are
// computed here from the pool's ticks. Staked positions earn emissions instead of fees; those are
// not read (left at 0, so My Lots shows no emissions line).
const NPM_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'positions',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
] as const;
const AERO_POOL_ABI = [
  { type: 'function', name: 'gauge', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'bool' }] },
  { type: 'function', name: 'feeGrowthGlobal0X128', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'feeGrowthGlobal1X128', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'ticks',
    stateMutability: 'view',
    inputs: [{ type: 'int24' }],
    outputs: [
      { type: 'uint128' }, { type: 'int128' }, { type: 'int128' }, { name: 'feeGrowthOutside0X128', type: 'uint256' }, { name: 'feeGrowthOutside1X128', type: 'uint256' },
      { type: 'uint256' }, { type: 'int56' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'bool' },
    ],
  },
] as const;
const GAUGE_ABI = [{ type: 'function', name: 'stakedValues', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256[]' }] }] as const;

const Q96N = 2n ** 96n;
const Q128N = 2n ** 128n;
const U256 = 2n ** 256n;
const sub256 = (a: bigint, b: bigint) => (((a - b) % U256) + U256) % U256;

function sqrtRatioAtTick(tick: number): bigint {
  return BigInt(Math.round(Math.sqrt(1.0001 ** tick) * 2 ** 96));
}

/** Token amounts a position's liquidity holds at the current price (Uniswap v3 LiquidityAmounts). */
function amountsForLiquidity(sqrtP: bigint, sqrtA: bigint, sqrtB: bigint, liquidity: bigint): [bigint, bigint] {
  if (sqrtP <= sqrtA) return [(liquidity * Q96N * (sqrtB - sqrtA)) / sqrtB / sqrtA, 0n];
  if (sqrtP >= sqrtB) return [0n, (liquidity * (sqrtB - sqrtA)) / Q96N];
  return [(liquidity * Q96N * (sqrtB - sqrtP)) / sqrtB / sqrtP, (liquidity * (sqrtP - sqrtA)) / Q96N];
}

async function readPositions(address: `0x${string}`, manager: `0x${string}`, pools: CbStock[]): Promise<LpPosition[]> {
  const client = getClient();
    try {
    const [count, gauges] = await Promise.all([
      client.readContract({ address: manager, abi: NPM_ABI, functionName: 'balanceOf', args: [address] }),
      client.multicall({ contracts: pools.map((s) => ({ address: s.pool.address, abi: AERO_POOL_ABI, functionName: 'gauge' as const })), allowFailure: true }),
    ]);
    const n = Number(count > POSITION_LIMIT ? POSITION_LIMIT : count);
    const [owned, staked] = await Promise.all([
      client.multicall({
        contracts: Array.from({ length: n }, (_, i) => ({ address: manager, abi: NPM_ABI, functionName: 'tokenOfOwnerByIndex' as const, args: [address, BigInt(i)] as const })),
        allowFailure: true,
      }),
      client.multicall({
        contracts: gauges.flatMap((g) => (g.status === 'success' && g.result !== ZERO_ADDRESS ? [{ address: g.result, abi: GAUGE_ABI, functionName: 'stakedValues' as const, args: [address] as const }] : [])),
        allowFailure: true,
      }),
    ]);
    const ids = [
      ...owned.flatMap((r) => (r.status === 'success' ? [{ id: r.result as bigint, staked: false }] : [])),
      ...staked.flatMap((r) => (r.status === 'success' ? (r.result as readonly bigint[]).map((id) => ({ id, staked: true })) : [])),
    ].slice(0, Number(POSITION_LIMIT));
    if (ids.length === 0) return [];

    const infos = await client.multicall({
      contracts: ids.map(({ id }) => ({ address: manager, abi: NPM_ABI, functionName: 'positions' as const, args: [id] as const })),
      allowFailure: true,
    });
    const out: LpPosition[] = [];
    for (let i = 0; i < ids.length; i++) {
      const info = infos[i];
      if (info.status !== 'success') continue;
      const [, , token0, token1, tickSpacing, tickLower, tickUpper, liquidity, fgIn0Last, fgIn1Last, owed0, owed1] = info.result;
      const stock = pools.find(
        (s) =>
          s.pool.tickSpacing === tickSpacing &&
          [token0, token1].map((t) => t.toLowerCase()).includes(s.tokenAddress.toLowerCase()) &&
          [token0, token1].map((t) => t.toLowerCase()).includes('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      );
      if (!stock) continue;
      const pool = stock.pool.address;
      // One position's failed read skips that position, not the wallet's others.
      const reads = await client
        .multicall({
        contracts: [
          { address: pool, abi: AERO_POOL_ABI, functionName: 'slot0' },
          { address: pool, abi: AERO_POOL_ABI, functionName: 'feeGrowthGlobal0X128' },
          { address: pool, abi: AERO_POOL_ABI, functionName: 'feeGrowthGlobal1X128' },
          { address: pool, abi: AERO_POOL_ABI, functionName: 'ticks', args: [tickLower] },
          { address: pool, abi: AERO_POOL_ABI, functionName: 'ticks', args: [tickUpper] },
          ],
          allowFailure: false,
        })
        .catch(() => null);
      if (!reads) continue;
      const [slot0, g0, g1, lower, upper] = reads;
      const [sqrtP, tick] = slot0;
      const sqrtA = sqrtRatioAtTick(tickLower);
      const sqrtB = sqrtRatioAtTick(tickUpper);
      const [amount0, amount1] = amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);

      // Uncollected fees (Uniswap v3 Position.update): owed + liquidity x growth inside since last touch.
      // A staked position's liquidity earns emissions, not fees, so it accrues none here.
      let earned0 = owed0;
      let earned1 = owed1;
      if (!ids[i].staked) {
        const outside = (t: typeof lower, k: 3 | 4) => t[k] as bigint;
        const inside = (global: bigint, k: 3 | 4) => {
          const below = tick >= tickLower ? outside(lower, k) : sub256(global, outside(lower, k));
          const above = tick < tickUpper ? outside(upper, k) : sub256(global, outside(upper, k));
          return sub256(sub256(global, below), above);
        };
        earned0 += (liquidity * sub256(inside(g0, 3), fgIn0Last)) / Q128N;
        earned1 += (liquidity * sub256(inside(g1, 4), fgIn1Last)) / Q128N;
      }
      out.push({
        id: ids[i].id,
        lp: pool,
        liquidity,
        staked: ids[i].staked ? liquidity : 0n,
        amount0: ids[i].staked ? 0n : amount0,
        amount1: ids[i].staked ? 0n : amount1,
        staked0: ids[i].staked ? amount0 : 0n,
        staked1: ids[i].staked ? amount1 : 0n,
        unstaked_earned0: earned0,
        unstaked_earned1: earned1,
        emissions_earned: 0n,
        tick_lower: tickLower,
        tick_upper: tickUpper,
        sqrt_ratio_lower: sqrtA,
        sqrt_ratio_upper: sqrtB,
        locker: ZERO_ADDRESS,
        unlocks_at: 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface SpotHolding {
  symbol: string;
  shares: number;
  usdValue: number;
}

export interface LpHolding {
  symbol: string;
  usdcAmount: number;
  shares: number;
  usdValue: number;
  tickLower: number;
  tickUpper: number;
  /** null when the pool's current tick isn't available (e.g. that symbol's
   *  tape fetch failed this cycle) — distinct from a known false. */
  inRange: boolean | null;
  rangeLowUsd: number;
  rangeHighUsd: number;
  feesEarnedUsd: number;
  emissionsEarnedAero: number;
  /** Epoch ms the position unlocks, or null if it isn't locked. */
  lockedUntil: number | null;
  /** Same as tapeRows' onchainMidUsd for this symbol — surfaced here so the
   *  client can place a range-position marker without also fetching tape. */
  currentPriceUsd: number | null;
  /** Fee APR of this position's own range while the price is inside it
   *  (unstaked: lib/feeApr.ts full-range APR x the range's capital
   *  efficiency); null when out of range (it earns no fees) or no data yet.
   *  Falls back to a rougher recent-swaps estimate (feeAprEstimated: true)
   *  until at least two daily cron snapshots exist. */
  feeAprPct: number | null;
  feeAprWindowDays: number | null;
  feeAprEstimated: boolean;
  /** P(price is back inside this range at the IN_RANGE_HORIZON_DAYS horizon)
   *  — null until enough price history has accumulated (see
   *  lib/volatility.ts). */
  inRangeProbabilityPct: number | null;
  inRangeHorizonDays: number | null;
  /** AERO emissions APR of this position's range if it were staked, on the
   *  same basis as feeAprPct (lib/gaugeYield.ts); null when out of range or
   *  when AERO's price or the gauge can't be read. */
  gaugeAprPct: number | null;
  /** % of this pool's total active liquidity currently staked (not this
   *  position specifically — a pool-wide figure). */
  stakedRatioPct: number | null;
  /** Whether this position's own liquidity is staked (from the position manager or gauge,
   *  position.staked field) — which side of the fee-vs-gauge comparison
   *  actually applies to what this wallet is currently earning. */
  isStaked: boolean;
  /** Most recent epoch's veAERO voting incentives (bribes) vs. real
   *  trading fee revenue for this pool — see lib/gaugeYield.ts. null
   *  until an epoch with data is readable. */
  /** True for a position in the stock's old pool (lib/lots.ts LEGACY_POOLS), before the Aero move. */
  oldPool: boolean;
  votingIncentiveFlag: {
    bribesUsd: number;
    hasUnpricedBribes: boolean;
    feesUsd: number;
    outpacing: boolean;
  } | null;
}

export interface MyLots {
  spot: SpotHolding[];
  lp: LpHolding[];
}

function sharesFromRaw(raw: bigint, stock: CbStock, multiplierRaw: bigint): number {
  const multiplierRatio = Number(multiplierRaw) / MULTIPLIER_ONE;
  return (Number(raw) / 10 ** stock.decimals) * multiplierRatio;
}

export async function getMyLots(address: `0x${string}`, tapeRows: TapeRow[]): Promise<MyLots> {
  const client = getClient();

  const spotContracts = STOCKS.flatMap((stock) => [
    { address: stock.tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] },
    { address: stock.tokenAddress, abi: TOKEN_ABI, functionName: 'multiplier' },
  ]);

  const [spotResults, aeroPositions, olderPositions] = await Promise.all([
    client.multicall({ contracts: spotContracts, allowFailure: true }),
    readPositions(address, AERO_POSITION_MANAGER, STOCKS.filter((s) => s.pool.factory === AERO_CL_FACTORY)),
    readPositions(address, AERODROME_POSITION_MANAGER, [...STOCKS.filter((s) => s.pool.factory === CL_FACTORY), ...LEGACY_STOCKS]),
  ]);
  const positions = [...aeroPositions, ...olderPositions];

  // Multiplier is fetched once per stock here and reused for both spot and
  // LP share math below — it isn't part of the LP Position struct, and
  // re-deriving "1.0x unless proven otherwise" independently in two places
  // would be easy to let drift.
  const multiplierBySymbol = new Map<string, bigint>();
  STOCKS.forEach((stock, i) => {
    const result = spotResults[i * 2 + 1];
    multiplierBySymbol.set(stock.symbol, result.status === 'success' ? (result.result as bigint) : BigInt(MULTIPLIER_ONE));
  });

  const spot: SpotHolding[] = STOCKS.map((stock, i) => {
    const balanceResult = spotResults[i * 2];
    if (balanceResult.status !== 'success') return null;

    const balanceRaw = balanceResult.result as bigint;
    if (balanceRaw === 0n) return null;

    const shares = sharesFromRaw(balanceRaw, stock, multiplierBySymbol.get(stock.symbol)!);
    const row = tapeRows.find((r) => r.symbol === stock.symbol);
    const usdValue = row?.onchainMidUsd != null ? shares * row.onchainMidUsd : 0;

    return { symbol: stock.symbol, shares, usdValue };
  }).filter((s): s is SpotHolding => s !== null);

  const lpResults = await Promise.all(
    positions.map(async (pos) => {
      const match = stockForPool(pos.lp);
      if (!match) return null; // not one of our allowlisted pools — skip
      const { stock, legacy } = match;

      const totalAmount0 = pos.amount0 + pos.staked0;
      const totalAmount1 = pos.amount1 + pos.staked1;
      // token0 in the pool is either USDC or the stock, per lib/tokens.ts —
      // already established there to handle exactly this ambiguity.
      const usdcRaw = stock.pool.token0 === 'USDC' ? totalAmount0 : totalAmount1;
      const stockRaw = stock.pool.token0 === 'USDC' ? totalAmount1 : totalAmount0;

      if (usdcRaw === 0n && stockRaw === 0n) return null;

      const usdcAmount = Number(usdcRaw) / 1e6; // USDC is always 6dp
      const multiplier = multiplierBySymbol.get(stock.symbol)!;
      const shares = sharesFromRaw(stockRaw, stock, multiplier);
      const row = tapeRows.find((r) => r.symbol === stock.symbol);
      const shareUsd = row?.onchainMidUsd != null ? shares * row.onchainMidUsd : 0;

      // An old pool has its own tick, not the tape's (which is the stock's current pool).
      const tick = legacy ? await getCachedPoolState(stock).then((st) => st.tick, () => null) : (row?.tick ?? null);
      const inRange = tick != null ? pos.tick_lower <= tick && tick <= pos.tick_upper : null;

      // sqrt_ratio_lower maps to the *higher* USD price and sqrt_ratio_upper
      // to the lower one (inverse relationship — token0 is always USDC), so
      // compute both and sort rather than assume the naming implies order.
      const priceAtLower = priceFromSqrtX96(pos.sqrt_ratio_lower, multiplier, stock);
      const priceAtUpper = priceFromSqrtX96(pos.sqrt_ratio_upper, multiplier, stock);
      const rangeLowUsd = Math.min(priceAtLower, priceAtUpper);
      const rangeHighUsd = Math.max(priceAtLower, priceAtUpper);

      const totalEarned0 = pos.unstaked_earned0;
      const totalEarned1 = pos.unstaked_earned1;
      const earnedUsdcRaw = stock.pool.token0 === 'USDC' ? totalEarned0 : totalEarned1;
      const earnedStockRaw = stock.pool.token0 === 'USDC' ? totalEarned1 : totalEarned0;
      const earnedUsdc = Number(earnedUsdcRaw) / 1e6;
      const earnedStockUsd = row?.onchainMidUsd != null ? sharesFromRaw(earnedStockRaw, stock, multiplier) * row.onchainMidUsd : 0;
      const feesEarnedUsd = earnedUsdc + earnedStockUsd;
      const emissionsEarnedAero = Number(pos.emissions_earned) / 10 ** AERO_DECIMALS;

      const lockedUntil = pos.locker.toLowerCase() !== ZERO_ADDRESS && pos.unlocks_at > 0 ? pos.unlocks_at * 1000 : null;

      const currentPriceUsd = row?.onchainMidUsd ?? null;

      let feeAprPct: number | null = null;
      let feeAprWindowDays: number | null = null;
      let feeAprEstimated = false;
      let inRangeProbabilityPct: number | null = null;
      let inRangeHorizonDays: number | null = null;
      let gaugeAprPct: number | null = null;
      let stakedRatioPct: number | null = null;
      let votingIncentiveFlag: LpHolding['votingIncentiveFlag'] = null;
      if (currentPriceUsd != null) {
        const [priceHistory, poolState, incentiveFlag] = await Promise.all([
          getPriceHistory(stock.symbol, Date.now() - 30 * 24 * 60 * 60_000).catch(() => []),
          getCachedPoolState(stock).catch(() => null),
          getVotingIncentiveFlag(stock, currentPriceUsd).catch(() => null),
        ]);
        const feeApr = await computeFeeAprWithFallback(stock.symbol, stock, currentPriceUsd, multiplier).catch(() => null);
        if (feeApr) {
          feeAprPct = rangeAprPct(feeApr.fullRangeAprPct, rangeLowUsd, rangeHighUsd, currentPriceUsd);
          feeAprWindowDays = feeApr.windowDays;
          feeAprEstimated = feeApr.estimated;
        }
        const probability = computeInRangeProbabilityPct(priceHistory, currentPriceUsd, rangeLowUsd, rangeHighUsd);
        if (probability != null) {
          inRangeProbabilityPct = probability;
          inRangeHorizonDays = IN_RANGE_HORIZON_DAYS;
        }
        if (poolState) {
          const gaugeYield = await getGaugeYield(stock, poolState).catch(() => null);
          if (gaugeYield) {
            gaugeAprPct =
              gaugeYield.fullRangeGaugeAprPct != null
                ? rangeAprPct(gaugeYield.fullRangeGaugeAprPct, rangeLowUsd, rangeHighUsd, currentPriceUsd)
                : null;
            stakedRatioPct = gaugeYield.stakedRatioPct;
          }
        }
        votingIncentiveFlag = incentiveFlag;
      }

      return {
        symbol: stock.symbol,
        usdcAmount,
        shares,
        usdValue: usdcAmount + shareUsd,
        tickLower: pos.tick_lower,
        tickUpper: pos.tick_upper,
        inRange,
        rangeLowUsd,
        rangeHighUsd,
        feesEarnedUsd,
        emissionsEarnedAero,
        lockedUntil,
        currentPriceUsd,
        feeAprPct,
        feeAprWindowDays,
        feeAprEstimated,
        inRangeProbabilityPct,
        inRangeHorizonDays,
        gaugeAprPct,
        stakedRatioPct,
        isStaked: pos.staked > 0n,
        oldPool: legacy,
        votingIncentiveFlag,
      };
    }),
  );
  const lp: LpHolding[] = lpResults.filter((p): p is LpHolding => p !== null);

  return { spot, lp };
}
