import { getClient, TOKEN_ABI, ERC20_ABI, MULTIPLIER_ONE, priceFromSqrtX96, getCachedPoolState } from './quote';
import { STOCKS, CL_FACTORY, type CbStock } from './tokens';
import type { TapeRow } from './tape';
import { computeFeeApr } from './feeApr';
import { getPriceHistory, computeInRangeProbabilityPct, IN_RANGE_HORIZON_DAYS } from './volatility';
import { getGaugeYield, getVotingIncentiveFlag } from './gaugeYield';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// AERO is a standard 18-decimal ERC20 — Sugar's emissions_earned is denominated
// in it. This app has no AERO/USDC pool tracked, so there's no price feed to
// convert it to USD; shown as a raw token amount instead of inventing one.
const AERO_DECIMALS = 18;

// Aerodrome/Velodrome's official on-chain read-helper ("Sugar") contract on
// Base — confirmed against Aerodrome's own deployments/base.env manifest.
// Not the same as the publicly-documented NonfungiblePositionManager
// (0x82792268...), which is bound to a different, wrong CL factory for
// these specific pools (its factory() returns 0x5e7BB104..., not ours) —
// Sugar's positionsByFactory takes our factory directly and does the
// tick-range math for us, verified live on-chain against the real deployed
// contract before writing this.
const LP_SUGAR = '0x69dD9db6d8f8E7d83887A704f447b1a584b599A1' as const;

const POSITION_COMPONENTS = [
  { name: 'id', type: 'uint256' },
  { name: 'lp', type: 'address' },
  { name: 'liquidity', type: 'uint256' },
  { name: 'staked', type: 'uint256' },
  { name: 'amount0', type: 'uint256' },
  { name: 'amount1', type: 'uint256' },
  { name: 'staked0', type: 'uint256' },
  { name: 'staked1', type: 'uint256' },
  { name: 'unstaked_earned0', type: 'uint256' },
  { name: 'unstaked_earned1', type: 'uint256' },
  { name: 'emissions_earned', type: 'uint256' },
  { name: 'tick_lower', type: 'int24' },
  { name: 'tick_upper', type: 'int24' },
  { name: 'sqrt_ratio_lower', type: 'uint160' },
  { name: 'sqrt_ratio_upper', type: 'uint160' },
  { name: 'locker', type: 'address' },
  { name: 'unlocks_at', type: 'uint32' },
  { name: 'alm', type: 'address' },
] as const;

const LP_SUGAR_ABI = [
  {
    type: 'function',
    name: 'positionsByFactory',
    stateMutability: 'view',
    inputs: [
      { name: '_limit', type: 'uint256' },
      { name: '_offset', type: 'uint256' },
      { name: '_account', type: 'address' },
      { name: '_factory', type: 'address' },
    ],
    outputs: [{ type: 'tuple[]', components: POSITION_COMPONENTS }],
  },
] as const;

// Sugar returns positions across every pool the factory has ever created —
// well above what one wallet realistically holds across ten stocks, but
// bounded rather than unbounded.
const POSITION_LIMIT = 50n;

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
  /** Pool-wide fee APR from a feeGrowthGlobal snapshot delta (see
   *  lib/feeApr.ts) — null until at least two daily cron snapshots exist. */
  feeAprPct: number | null;
  feeAprWindowDays: number | null;
  /** P(price is back inside this range at the IN_RANGE_HORIZON_DAYS horizon)
   *  — null until enough price history has accumulated (see
   *  lib/volatility.ts). */
  inRangeProbabilityPct: number | null;
  inRangeHorizonDays: number | null;
  /** Annualized AERO emissions yield if this pool's liquidity were staked
   *  in its gauge — see lib/gaugeYield.ts for the real on-chain reads
   *  behind this (reward rate, staked liquidity, AERO's own price) and
   *  the approximation it makes valuing staked liquidity in USD. null
   *  until AERO's price and the pool's gauge state are both readable. */
  gaugeAprPct: number | null;
  /** % of this pool's total active liquidity currently staked (not this
   *  position specifically — a pool-wide figure). */
  stakedRatioPct: number | null;
  /** Whether this position's own liquidity is staked (from Sugar's
   *  position.staked field) — which side of the fee-vs-gauge comparison
   *  actually applies to what this wallet is currently earning. */
  isStaked: boolean;
  /** Most recent epoch's veAERO voting incentives (bribes) vs. real
   *  trading fee revenue for this pool — see lib/gaugeYield.ts. null
   *  until an epoch with data is readable. */
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

  const [spotResults, positions] = await Promise.all([
    client.multicall({ contracts: spotContracts, allowFailure: true }),
    client
      .readContract({
        address: LP_SUGAR,
        abi: LP_SUGAR_ABI,
        functionName: 'positionsByFactory',
        args: [POSITION_LIMIT, 0n, address, CL_FACTORY],
      })
      .catch(() => []),
  ]);

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
      const stock = STOCKS.find((s) => s.pool.address.toLowerCase() === pos.lp.toLowerCase());
      if (!stock) return null; // not one of our ten allowlisted pools — skip

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

      const inRange = row?.tick != null ? pos.tick_lower <= row.tick && row.tick <= pos.tick_upper : null;

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
      let inRangeProbabilityPct: number | null = null;
      let inRangeHorizonDays: number | null = null;
      let gaugeAprPct: number | null = null;
      let stakedRatioPct: number | null = null;
      let votingIncentiveFlag: LpHolding['votingIncentiveFlag'] = null;
      if (currentPriceUsd != null) {
        const [feeApr, priceHistory, poolState, incentiveFlag] = await Promise.all([
          computeFeeApr(stock.symbol, stock, currentPriceUsd, multiplier).catch(() => null),
          getPriceHistory(stock.symbol, Date.now() - 30 * 24 * 60 * 60_000).catch(() => []),
          getCachedPoolState(stock).catch(() => null),
          getVotingIncentiveFlag(stock, currentPriceUsd).catch(() => null),
        ]);
        if (feeApr) {
          feeAprPct = feeApr.aprPct;
          feeAprWindowDays = feeApr.windowDays;
        }
        const probability = computeInRangeProbabilityPct(priceHistory, currentPriceUsd, rangeLowUsd, rangeHighUsd);
        if (probability != null) {
          inRangeProbabilityPct = probability;
          inRangeHorizonDays = IN_RANGE_HORIZON_DAYS;
        }
        if (poolState) {
          const gaugeYield = await getGaugeYield(stock, poolState).catch(() => null);
          if (gaugeYield) {
            gaugeAprPct = gaugeYield.gaugeAprPct;
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
        inRangeProbabilityPct,
        inRangeHorizonDays,
        gaugeAprPct,
        stakedRatioPct,
        isStaked: pos.staked > 0n,
        votingIncentiveFlag,
      };
    }),
  );
  const lp: LpHolding[] = lpResults.filter((p): p is LpHolding => p !== null);

  return { spot, lp };
}
