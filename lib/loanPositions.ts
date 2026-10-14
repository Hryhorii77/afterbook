import { parseAbi, type Abi } from 'viem';
import { getClient, getCachedPoolState, midPriceUsd, MULTIPLIER_ONE } from './quote';
import { AAVE_MAG7_SPOKE, getAaveStockLending } from './aave';
import { getMorphoStockMarkets } from './morpho';
import { getStock, USDC } from './tokens';
import type { LoanCollateral, WalletLoan } from './loanHealth';

// A wallet's stock-backed USDC loans on Base, for the Telegram loan alerts. Read-only: an address
// is public, and nothing here can sign or move anything. Aave V4 (the MAG7 spoke, one position per
// wallet with every stock in it) and every listed Morpho stock market (one position per market).

// Morpho Blue core on Base (same address on every chain; checked on-chain 2026-10-14).
const MORPHO_BLUE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const;
const MORPHO_ABI = parseAbi([
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
]);
const AAVE_ABI = parseAbi([
  'struct UserAccountData { uint256 riskPremium; uint256 avgCollateralFactor; uint256 healthFactor; uint256 totalCollateralValue; uint256 totalDebtValueRay; uint256 activeCollateralCount; uint256 borrowCount; }',
  'function getUserAccountData(address user) view returns (UserAccountData)',
  'function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)',
  'function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)',
  'function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)',
]);

/** USD per token on Aerodrome (the pool's per-share mid times the token's share multiplier). */
async function aeroPricePerToken(symbol: string): Promise<number | null> {
  const stock = getStock(symbol);
  if (!stock) return null;
  try {
    const state = await getCachedPoolState(stock);
    return midPriceUsd(state, stock) * (Number(state.multiplier) / MULTIPLIER_ONE);
  } catch {
    return null;
  }
}

async function aaveLoan(wallet: `0x${string}`): Promise<WalletLoan | null> {
  const client = getClient();
  const read = <T>(functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: AAVE_MAG7_SPOKE, abi: AAVE_ABI as Abi, functionName, args } as Parameters<typeof client.readContract>[0]) as Promise<T>;
  const account = await read<{ healthFactor: bigint; borrowCount: bigint }>('getUserAccountData', [wallet]);
  if (account.borrowCount === BigInt(0)) return null;

  const { markets, usdcReserveId } = await getAaveStockLending();
  const debtRaw = await read<bigint>('getUserTotalDebt', [BigInt(usdcReserveId), wallet]);
  const collateral = await Promise.all(
    markets.map(async (m): Promise<LoanCollateral | null> => {
      const id = BigInt(m.marketId.slice('aave:'.length));
      const [supplied, [usedAsCollateral]] = await Promise.all([
        read<bigint>('getUserSuppliedAssets', [id, wallet]),
        read<readonly [boolean, boolean]>('getUserReserveStatus', [id, wallet]),
      ]);
      const stock = getStock(m.symbol);
      if (!stock || supplied === BigInt(0) || !usedAsCollateral || m.oraclePriceUsd == null) return null;
      return {
        symbol: m.symbol,
        amount: Number(supplied) / 10 ** stock.decimals,
        oraclePriceUsd: m.oraclePriceUsd,
        aeroPriceUsd: await aeroPricePerToken(m.symbol),
        collateralFactor: m.lltv,
      };
    }),
  );
  return {
    venue: 'aave',
    collateral: collateral.filter((c): c is LoanCollateral => c != null),
    debtUsd: Number(debtRaw) / 10 ** USDC.decimals,
    healthFactor: Number(account.healthFactor) / 1e18,
  };
}

async function morphoLoans(wallet: `0x${string}`): Promise<WalletLoan[]> {
  const client = getClient();
  const markets = (await getMorphoStockMarkets()).filter((m) => m.oraclePriceUsd != null);
  const positions = await client.multicall({
    contracts: markets.map((m) => ({ address: MORPHO_BLUE, abi: MORPHO_ABI, functionName: 'position', args: [m.marketId as `0x${string}`, wallet] }) as const),
    allowFailure: false,
  });
  const open = markets.map((m, i) => ({ m, p: positions[i] })).filter(({ p }) => p[1] > BigInt(0));
  return Promise.all(
    open.map(async ({ m, p }) => {
      const stock = getStock(m.symbol)!;
      const [, , totalBorrowAssets, totalBorrowShares] = await client.readContract({ address: MORPHO_BLUE, abi: MORPHO_ABI, functionName: 'market', args: [m.marketId as `0x${string}`] });
      // Morpho's share maths (SharesMathLib.toAssetsUp, 1e6 virtual shares, 1 virtual asset), before
      // interest accrued since the market's last update: a few seconds' interest at most is missing.
      const debtRaw = (p[1] * (totalBorrowAssets + BigInt(1)) + totalBorrowShares + BigInt(1_000_000) - BigInt(1)) / (totalBorrowShares + BigInt(1_000_000));
      const debtUsd = Number(debtRaw) / 10 ** USDC.decimals;
      const amount = Number(p[2]) / 10 ** stock.decimals;
      const oraclePriceUsd = m.oraclePriceUsd!;
      return {
        venue: 'morpho' as const,
        collateral: [{ symbol: m.symbol, amount, oraclePriceUsd, aeroPriceUsd: await aeroPricePerToken(m.symbol), collateralFactor: m.lltv }],
        debtUsd,
        healthFactor: debtUsd > 0 ? (amount * oraclePriceUsd * m.lltv) / debtUsd : Infinity,
      };
    }),
  );
}

/** Every open stock loan of a wallet. Throws if a lender can't be read, so an alert never takes a
 *  failed read for "no loans" and re-arms by mistake. */
export async function getWalletLoans(wallet: `0x${string}`): Promise<WalletLoan[]> {
  const [aave, morpho] = await Promise.all([aaveLoan(wallet), morphoLoans(wallet)]);
  return [...(aave ? [aave] : []), ...morpho];
}
