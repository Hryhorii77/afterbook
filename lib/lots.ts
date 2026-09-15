import { getClient, TOKEN_ABI, ERC20_ABI, MULTIPLIER_ONE } from './quote';
import { STOCKS, CL_FACTORY, type CbStock } from './tokens';
import type { TapeRow } from './tape';

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

  const lp: LpHolding[] = positions
    .map((pos) => {
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
      const shares = sharesFromRaw(stockRaw, stock, multiplierBySymbol.get(stock.symbol)!);
      const row = tapeRows.find((r) => r.symbol === stock.symbol);
      const shareUsd = row?.onchainMidUsd != null ? shares * row.onchainMidUsd : 0;

      return { symbol: stock.symbol, usdcAmount, shares, usdValue: usdcAmount + shareUsd };
    })
    .filter((p): p is LpHolding => p !== null);

  return { spot, lp };
}
