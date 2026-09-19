import { getClient, poolDepth, type PoolState } from './quote';
import type { CbStock } from './tokens';
import { USDC } from './tokens';

// Every address below was read live from Aerodrome/Velodrome's own official
// deployment manifest (velodrome-finance/sugar's deployments/base.env) or
// derived from a live on-chain call and cross-checked two independent ways
// before being hardcoded here — same trust bar as lib/tokens.ts. In
// particular: Voter.gauges(pool) and CLPool.gauge() were confirmed to
// return identical addresses for all ten pools, and CLPool.rewardRate()
// was confirmed to match CLGauge.rewardRate() exactly for all ten — see
// this feature's own verification history for the live probe scripts.
const REWARDS_SUGAR = '0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678' as const;
export const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as const;
const AERO_DECIMALS = 18;

// The deepest of three real AERO/USDC Slipstream pools found via the main
// public CL factory's getPool(AERO, USDC, tickSpacing) — the other two
// (tickSpacing 1 and 200) carry $0.28 and ~$92k respectively vs this one's
// ~$254k, confirmed live. token0 is USDC here too, same convention as
// every stock pool this app already reads.
const AERO_USDC_POOL = '0xa4FDd479eda160671636e2eCF8f993Cbf86258a8' as const;

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const Q96 = 2 ** 96;

const SLOT0_ABI = [
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
] as const;

const POOL_GAUGE_ABI = [
  { type: 'function', name: 'stakedLiquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { type: 'function', name: 'rewardRate', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

let cachedAeroPrice: { price: number; fetchedAt: number } | null = null;
const AERO_PRICE_CACHE_TTL_MS = 60_000;

/** AERO's own USD price, read from a real on-chain Aerodrome pool — this
 *  app previously had no AERO price source at all (lib/lots.ts used to
 *  show emissions_earned as a raw token amount for exactly that reason);
 *  this closes that gap the same way every other price in this app is
 *  read, not via a third-party feed. */
export async function getAeroUsdPrice(): Promise<number | null> {
  const now = Date.now();
  if (cachedAeroPrice && now - cachedAeroPrice.fetchedAt < AERO_PRICE_CACHE_TTL_MS) {
    return cachedAeroPrice.price;
  }
  try {
    const client = getClient();
    const [sqrtPriceX96] = await client.readContract({ address: AERO_USDC_POOL, abi: SLOT0_ABI, functionName: 'slot0' });
    const sqrtP = Number(sqrtPriceX96) / Q96;
    // Same math as lib/quote.ts's priceFromSqrtX96, inlined rather than
    // reused because that function is typed against CbStock and AERO isn't
    // one — token0=USDC here too, so the direction is identical.
    const rawToken1PerToken0 = sqrtP * sqrtP;
    const decAdjusted = rawToken1PerToken0 * 10 ** (USDC.decimals - AERO_DECIMALS);
    const price = 1 / decAdjusted;
    cachedAeroPrice = { price, fetchedAt: now };
    return price;
  } catch {
    return null;
  }
}

export interface GaugeYield {
  /** null if AERO's price or the pool's staked liquidity couldn't be read
   *  this call, or if nothing is staked. */
  gaugeAprPct: number | null;
  stakedRatioPct: number;
}

/**
 * Gauge staking APR vs. lib/feeApr.ts's unstaked fee APR — both annualized
 * so they're directly comparable. Staked liquidity's USD value can't be
 * derived from the virtual-reserve math lib/quote.ts's estimateLot uses
 * (that describes trade-impact behavior, not actual token holdings, and
 * systematically overstates value for a concentrated position — caught
 * this exact bug while building it, see the fix history). Instead this
 * takes the pool's real, balance-based total value (lib/quote.ts's
 * poolDepth) and scales it by staked/total liquidity — an approximation
 * assuming staked and unstaked positions are concentrated similarly on
 * average, not exact, but far more honest than the broken virtual-reserve
 * approach it replaced.
 */
export async function getGaugeYield(stock: CbStock, state: PoolState): Promise<GaugeYield | null> {
  const client = getClient();
  const [stakedLiqResult, rewardRateResult, aeroPrice] = await Promise.all([
    client.readContract({ address: stock.pool.address, abi: POOL_GAUGE_ABI, functionName: 'stakedLiquidity' }).catch(() => null),
    client.readContract({ address: stock.pool.address, abi: POOL_GAUGE_ABI, functionName: 'rewardRate' }).catch(() => null),
    getAeroUsdPrice(),
  ]);
  if (stakedLiqResult == null || rewardRateResult == null) return null;

  const stakedRatioPct = state.liquidity > 0n ? (Number(stakedLiqResult) / Number(state.liquidity)) * 100 : 0;

  let gaugeAprPct: number | null = null;
  if (aeroPrice != null) {
    const depth = poolDepth(state, stock);
    const stakedLiquidityUsd = depth.totalUsd * (stakedRatioPct / 100);
    const annualAeroEmitted = (Number(rewardRateResult) * SECONDS_PER_YEAR) / 10 ** AERO_DECIMALS;
    const annualEmissionsUsd = annualAeroEmitted * aeroPrice;
    gaugeAprPct = stakedLiquidityUsd > 0 ? (annualEmissionsUsd / stakedLiquidityUsd) * 100 : null;
  }

  return { gaugeAprPct, stakedRatioPct };
}

const REWARD_COMPONENTS = [
  { name: 'token', type: 'address' },
  { name: 'amount', type: 'uint256' },
] as const;
const EPOCH_COMPONENTS = [
  { name: 'ts', type: 'uint256' },
  { name: 'lp', type: 'address' },
  { name: 'votes', type: 'uint256' },
  { name: 'emissions', type: 'uint256' },
  { name: 'bribes', type: 'tuple[]', components: REWARD_COMPONENTS },
  { name: 'fees', type: 'tuple[]', components: REWARD_COMPONENTS },
] as const;
const REWARDS_SUGAR_ABI = [
  {
    type: 'function',
    name: 'epochsByAddress',
    stateMutability: 'view',
    inputs: [
      { name: '_limit', type: 'uint256' },
      { name: '_offset', type: 'uint256' },
      { name: '_address', type: 'address' },
    ],
    outputs: [{ type: 'tuple[]', components: EPOCH_COMPONENTS }],
  },
] as const;

export interface VotingIncentiveFlag {
  bribesUsd: number;
  /** true when at least one bribe token this epoch wasn't AERO or USDC —
   *  those aren't priced (no feed), so bribesUsd is a floor, not exact. */
  hasUnpricedBribes: boolean;
  feesUsd: number;
  outpacing: boolean;
}

/**
 * Compares the most recent epoch's veAERO voting incentives (bribes paid
 * to direct emissions here) against real trading fee revenue for the same
 * pool/epoch — both from Aerodrome's own RewardsSugar contract, not
 * derived. High bribes relative to fees is a real signal that a pool's
 * gauge APR may be governance-subsidized rather than earned from organic
 * volume, i.e. less likely to persist once the incentive campaign ends.
 */
export async function getVotingIncentiveFlag(stock: CbStock, currentPriceUsd: number): Promise<VotingIncentiveFlag | null> {
  const client = getClient();
  const [aeroPrice, epochs] = await Promise.all([
    getAeroUsdPrice(),
    client
      .readContract({ address: REWARDS_SUGAR, abi: REWARDS_SUGAR_ABI, functionName: 'epochsByAddress', args: [1n, 0n, stock.pool.address] })
      .catch(() => null),
  ]);
  const epoch = epochs?.[0];
  if (!epoch) return null;

  let bribesUsd = 0;
  let hasUnpricedBribes = false;
  for (const b of epoch.bribes) {
    if (b.token.toLowerCase() === AERO_ADDRESS.toLowerCase() && aeroPrice != null) {
      bribesUsd += (Number(b.amount) / 10 ** AERO_DECIMALS) * aeroPrice;
    } else if (b.token.toLowerCase() === USDC.address.toLowerCase()) {
      bribesUsd += Number(b.amount) / 10 ** USDC.decimals;
    } else {
      hasUnpricedBribes = true;
    }
  }

  let feesUsd = 0;
  for (const f of epoch.fees) {
    if (f.token.toLowerCase() === USDC.address.toLowerCase()) {
      feesUsd += Number(f.amount) / 10 ** USDC.decimals;
    } else if (f.token.toLowerCase() === stock.tokenAddress.toLowerCase()) {
      feesUsd += (Number(f.amount) / 10 ** stock.decimals) * currentPriceUsd;
    }
  }

  return { bribesUsd, hasUnpricedBribes, feesUsd, outpacing: bribesUsd > feesUsd };
}
