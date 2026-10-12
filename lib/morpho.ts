import { getClient } from './quote';
import { STOCKS, USDC, type CbStock } from './tokens';

// Morpho Blue lending markets on Base where one of the tracked stocks is the
// collateral and USDC is the loan. The market list and its usage stats
// (collateral, borrows, APYs) come from Morpho's public GraphQL API; the
// oracle price — the number liquidations actually fire on — is read on-chain
// from each market's oracle, not taken from the API.
//
// Only `listed` markets are shown: anyone can create a Morpho market with any
// oracle, and unlisted ones on these tokens include empty duplicates with
// other oracles (checked 2026-10-12). Listed is Morpho's own curation flag.

const MORPHO_API = 'https://api.morpho.org/graphql';
const BASE_CHAIN_ID = 8453;

const ORACLE_ABI = [{ type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }] as const;

export interface MorphoStockMarket {
  marketId: `0x${string}`;
  symbol: string;
  lltv: number;
  oracleAddress: `0x${string}`;
  /** USD per share from the market's oracle, read on-chain. null if the read failed. */
  oraclePriceUsd: number | null;
  collateralUsd: number;
  borrowUsd: number;
  supplyUsd: number;
  /** USDC still available to borrow. */
  liquidityUsd: number;
  utilization: number;
  borrowApy: number;
  supplyApy: number;
}

interface ApiMarket {
  marketId: string;
  lltv: string;
  listed: boolean;
  oracle: { address: string } | null;
  collateralAsset: { address: string; decimals: number };
  loanAsset: { address: string; decimals: number };
  state: {
    collateralAssetsUsd: number | null;
    borrowAssetsUsd: number | null;
    supplyAssetsUsd: number | null;
    liquidityAssetsUsd: number | null;
    utilization: number | null;
    borrowApy: number | null;
    supplyApy: number | null;
  } | null;
}

const QUERY = `query($collateral: [String!]) {
  markets(first: 100, where: { chainId_in: [${BASE_CHAIN_ID}], collateralAssetAddress_in: $collateral }) {
    items {
      marketId lltv listed
      oracle { address }
      collateralAsset { address decimals }
      loanAsset { address decimals }
      state { collateralAssetsUsd borrowAssetsUsd supplyAssetsUsd liquidityAssetsUsd utilization borrowApy supplyApy }
    }
  }
}`;

async function fetchMarkets(): Promise<MorphoStockMarket[]> {
  const res = await fetch(MORPHO_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { collateral: STOCKS.map((s) => s.tokenAddress) } }),
    cache: 'no-store',
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`morpho api ${res.status}`);
  const json = (await res.json()) as { data?: { markets?: { items?: ApiMarket[] } }; errors?: unknown };
  if (json.errors || !json.data?.markets?.items) throw new Error(`morpho api error: ${JSON.stringify(json.errors ?? 'no data')}`);

  const bySymbol = new Map(STOCKS.map((s) => [s.tokenAddress.toLowerCase(), s]));
  const picked = json.data.markets.items
    .filter((m) => m.listed && m.oracle && m.loanAsset.address.toLowerCase() === USDC.address.toLowerCase())
    .map((m) => ({ m, stock: bySymbol.get(m.collateralAsset.address.toLowerCase()) }))
    .filter((x): x is { m: ApiMarket; stock: CbStock } => x.stock != null);

  const prices = await getClient().multicall({
    contracts: picked.map(({ m }) => ({ address: m.oracle!.address as `0x${string}`, abi: ORACLE_ABI, functionName: 'price' })),
    allowFailure: true,
  });

  return picked.map(({ m, stock }, i) => {
    const r = prices[i];
    // Morpho oracle price: loan raw units per collateral raw unit, scaled 1e36.
    // Converted to USD per raw-token share; lib/quote.ts's B20 multiplier is
    // applied by the caller next to the pool price (both read live).
    const oraclePriceUsd =
      r.status === 'success'
        ? (Number(r.result as bigint) / 1e36) * 10 ** (m.collateralAsset.decimals - m.loanAsset.decimals)
        : null;
    const s = m.state;
    return {
      marketId: m.marketId as `0x${string}`,
      symbol: stock.symbol,
      lltv: Number(BigInt(m.lltv)) / 1e18,
      oracleAddress: m.oracle!.address as `0x${string}`,
      oraclePriceUsd,
      collateralUsd: s?.collateralAssetsUsd ?? 0,
      borrowUsd: s?.borrowAssetsUsd ?? 0,
      supplyUsd: s?.supplyAssetsUsd ?? 0,
      liquidityUsd: s?.liquidityAssetsUsd ?? 0,
      utilization: s?.utilization ?? 0,
      borrowApy: s?.borrowApy ?? 0,
      supplyApy: s?.supplyApy ?? 0,
    };
  });
}

// Market usage moves slowly, so one minute of cache (oracle price included)
// keeps page loads and paid calls off Morpho's API and the RPC without
// showing anything a viewer would call stale.
const CACHE_TTL_MS = 60_000;
let cache: { markets: MorphoStockMarket[]; fetchedAt: number } | null = null;

export async function getMorphoStockMarkets(): Promise<MorphoStockMarket[]> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.markets;
  const markets = await fetchMarkets();
  cache = { markets, fetchedAt: now };
  return markets;
}

export const morphoMarketUrl = (marketId: string) => `https://app.morpho.org/base/market/${marketId}`;
