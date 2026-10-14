import { parseAbi, type Abi } from 'viem';
import { getClient } from './quote';
import { aaveV4LiquidationIncentiveFactor } from './liquidationMath';
import type { StockLendingMarket } from './lendingMarket';
import { STOCKS, USDC } from './tokens';

// Aave V4's Equities Hub on Base (live 2026-09-25): one USDC pool (the hub)
// lent through one spoke ("MAG7") that takes seven Coinbase stock tokens as
// collateral. Addresses from Aave's address book (bgd-labs/aave-address-book,
// src/AaveV4Base.sol: AaveV4BaseHubs.EQUITIES_HUB, AaveV4BaseSpokes.MAG7_SPOKE).
// Everything is read on-chain; there is no API or key. Interfaces:
// aave/aave-v4 src/spoke/interfaces/ISpoke.sol and src/hub/interfaces/IHub.sol.
export const AAVE_EQUITIES_HUB = '0xa4d5947Eb727A052bae69C593FfC84247EC9864E' as const;
export const AAVE_MAG7_SPOKE = '0x17905Db0e4A3514467539956c084180616AE7B8D' as const;
export const aaveSpokeUrl = `https://basescan.org/address/${AAVE_MAG7_SPOKE}`;

const SPOKE_ABI = parseAbi([
  'struct Reserve { address underlying; address hub; uint16 assetId; uint8 decimals; uint24 collateralRisk; uint8 flags; uint32 dynamicConfigKey; }',
  'struct ReserveConfig { uint24 collateralRisk; bool paused; bool frozen; bool borrowable; bool receiveSharesEnabled; }',
  'struct DynamicReserveConfig { uint16 collateralFactor; uint32 maxLiquidationBonus; uint16 liquidationFee; }',
  'struct LiquidationConfig { uint128 targetHealthFactor; uint64 healthFactorForMaxBonus; uint16 liquidationBonusFactor; }',
  'function getReserveCount() view returns (uint256)',
  'function getReserve(uint256 reserveId) view returns (Reserve)',
  'function getReserveConfig(uint256 reserveId) view returns (ReserveConfig)',
  'function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey) view returns (DynamicReserveConfig)',
  'function getReserveSuppliedAssets(uint256 reserveId) view returns (uint256)',
  'function getLiquidationConfig() view returns (LiquidationConfig)',
  'function ORACLE() view returns (address)',
]);
const HUB_ABI = parseAbi([
  'struct SpokeConfig { uint40 addCap; uint40 drawCap; uint24 riskPremiumThreshold; bool active; bool halted; }',
  'struct AssetConfig { address feeReceiver; uint16 liquidityFee; address irStrategy; address reinvestmentController; }',
  'function getSpokeConfig(uint256 assetId, address spoke) view returns (SpokeConfig)',
  'function getAssetConfig(uint256 assetId) view returns (AssetConfig)',
  'function getAddedAssets(uint256 assetId) view returns (uint256)',
  'function getAssetTotalOwed(uint256 assetId) view returns (uint256)',
  'function getAssetLiquidity(uint256 assetId) view returns (uint256)',
  'function getAssetDrawnRate(uint256 assetId) view returns (uint256)',
]);
const ORACLE_ABI = parseAbi(['function getReservesPrices(uint256[] reserveIds) view returns (uint256[])']);

// The spoke oracle answers in 8 decimals (USDC reads 0.9999e8); checked
// against USDC on every read so a change of units fails loudly, not silently.
const PRICE_DECIMALS = 8;
// Caps are stored in whole tokens, and this value means "no cap" (IHub.sol MAX_ALLOWED_SPOKE_CAP).
const NO_CAP = 2 ** 40 - 1;

/** The one USDC pool every Aave stock market borrows from. */
export interface AaveHubTotals {
  supplyUsd: number;
  borrowUsd: number;
  liquidityUsd: number;
  utilization: number;
  /** Variable borrow rate (APR) before any per-user risk premium; every stock's premium is 0 today. */
  borrowApr: number;
  /** What lenders earn: borrow rate x utilization, less the hub's fee. Excludes incentive programs. */
  supplyApr: number;
  /** Most USDC this spoke may borrow from the hub; null when uncapped. */
  borrowCapUsd: number | null;
}

export interface AaveStockLending {
  markets: StockLendingMarket[];
  hub: AaveHubTotals;
}

async function read(): Promise<AaveStockLending> {
  const client = getClient();
  // Results are typed at each call; the ABIs above are the contract.
  const call = <T>(address: `0x${string}`, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args } as Parameters<typeof client.readContract>[0]) as Promise<T>;
  const spoke = <T>(fn: string, args?: readonly unknown[]) => call<T>(AAVE_MAG7_SPOKE, SPOKE_ABI, fn, args);
  const hubRead = <T>(fn: string, args?: readonly unknown[]) => call<T>(AAVE_EQUITIES_HUB, HUB_ABI, fn, args);

  const [count, oracle, liq] = await Promise.all([
    spoke<bigint>('getReserveCount'),
    spoke<`0x${string}`>('ORACLE'),
    spoke<{ liquidationBonusFactor: number }>('getLiquidationConfig'),
  ]);
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
  const reserves = await Promise.all(
    ids.map((id) => spoke<{ underlying: `0x${string}`; assetId: number; decimals: number; dynamicConfigKey: number }>('getReserve', [id])),
  );
  const prices = await call<readonly bigint[]>(oracle, ORACLE_ABI, 'getReservesPrices', [ids]);
  const priceUsd = (i: number) => Number(prices[i]) / 10 ** PRICE_DECIMALS;

  const usdcIdx = reserves.findIndex((r) => r.underlying.toLowerCase() === USDC.address.toLowerCase());
  if (usdcIdx < 0) throw new Error('aave: no USDC reserve on the spoke');
  if (Math.abs(priceUsd(usdcIdx) - 1) > 0.05) throw new Error(`aave: USDC oracle reads ${priceUsd(usdcIdx)}, price units changed`);
  const usdcAsset = BigInt(reserves[usdcIdx].assetId);
  const usd6 = (x: bigint) => Number(x) / 10 ** USDC.decimals;

  const [added, owed, liquidity, rate, assetCfg, usdcSpoke] = await Promise.all([
    hubRead<bigint>('getAddedAssets', [usdcAsset]),
    hubRead<bigint>('getAssetTotalOwed', [usdcAsset]),
    hubRead<bigint>('getAssetLiquidity', [usdcAsset]),
    hubRead<bigint>('getAssetDrawnRate', [usdcAsset]),
    hubRead<{ liquidityFee: number }>('getAssetConfig', [usdcAsset]),
    hubRead<{ drawCap: bigint | number }>('getSpokeConfig', [usdcAsset, AAVE_MAG7_SPOKE]),
  ]);
  const supplyUsd = usd6(added);
  const borrowUsd = usd6(owed);
  const utilization = supplyUsd > 0 ? borrowUsd / supplyUsd : 0;
  const borrowApr = Number(rate) / 1e27; // RAY, per year
  const drawCap = Number(usdcSpoke.drawCap);
  const hub: AaveHubTotals = {
    supplyUsd,
    borrowUsd,
    liquidityUsd: usd6(liquidity),
    utilization,
    borrowApr,
    supplyApr: borrowApr * utilization * (1 - assetCfg.liquidityFee / 10_000),
    borrowCapUsd: drawCap >= NO_CAP ? null : drawCap,
  };

  const byAddress = new Map(STOCKS.map((s) => [s.tokenAddress.toLowerCase(), s]));
  const stockIdx = reserves.map((r, i) => ({ r, i, stock: byAddress.get(r.underlying.toLowerCase()) })).filter((x) => x.stock);
  const markets = await Promise.all(
    stockIdx.map(async ({ r, i, stock }): Promise<StockLendingMarket | null> => {
      const id = BigInt(i);
      const [cfg, dyn, supplied, spokeCfg] = await Promise.all([
        spoke<{ paused: boolean }>('getReserveConfig', [id]),
        spoke<{ collateralFactor: number; maxLiquidationBonus: number; liquidationFee: number }>('getDynamicReserveConfig', [id, r.dynamicConfigKey]),
        spoke<bigint>('getReserveSuppliedAssets', [id]),
        hubRead<{ addCap: bigint | number }>('getSpokeConfig', [BigInt(r.assetId), AAVE_MAG7_SPOKE]),
      ]);
      // A paused reserve or one that is not collateral at all is not a market to show.
      if (cfg.paused || dyn.collateralFactor === 0) return null;
      const price = priceUsd(i);
      const addCap = Number(spokeCfg.addCap);
      return {
        venue: 'aave',
        marketId: `aave:${i}`,
        symbol: stock!.symbol,
        lltv: dyn.collateralFactor / 10_000,
        liquidationIncentiveFactor: aaveV4LiquidationIncentiveFactor(dyn.maxLiquidationBonus, liq.liquidationBonusFactor, dyn.liquidationFee),
        oracleAddress: oracle,
        oraclePriceUsd: price > 0 ? price : null,
        collateralUsd: (Number(supplied) / 10 ** r.decimals) * price,
        collateralCapUsd: addCap >= NO_CAP ? null : addCap * price,
        borrowUsd: null,
        supplyUsd: null,
        liquidityUsd: null,
        utilization: null,
        borrowApy: hub.borrowApr,
        supplyApy: hub.supplyApr,
        url: aaveSpokeUrl,
      };
    }),
  );
  return { markets: markets.filter((m): m is StockLendingMarket => m != null), hub };
}

// Same one-minute cache as lib/morpho.ts: usage moves slowly, and it keeps
// page loads and paid calls to a handful of RPC reads a minute.
const CACHE_TTL_MS = 60_000;
let cache: { value: AaveStockLending; fetchedAt: number } | null = null;

export async function getAaveStockLending(): Promise<AaveStockLending> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.value;
  const value = await read();
  cache = { value, fetchedAt: now };
  return value;
}
