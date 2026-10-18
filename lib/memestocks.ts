// Memestocks: Base meme tokens whose pool is quoted in one of our tracked stock tokens (BLUECHIP/NVDAc,
// IPOD/AAPLc…). A daily job (app/api/cron/discover-memes) finds candidate pools on Dexscreener, proves
// each one on-chain and stores the survivors as their own allowlist in Redis (`memes:pools`). It never
// touches STOCKS or BASKET_SYMBOLS. Pages read the allowlist (cached an hour) plus live numbers from
// Dexscreener (cached two minutes); a page view never reads the chain.
//
// What "verified" means, per venue (checked 2026-10-18; most of this market is on Uniswap v4):
//  - Aerodrome Slipstream: the pool's factory() is CL_FACTORY (the one our stock pools use) and
//    CL_FACTORY.getPool(token0, token1, tickSpacing) returns this pool.
//  - Uniswap v3: factory() is Uniswap's v3 factory on Base and getPool(token0, token1, fee) returns it.
//  - Uniswap v4 ('proven'): Uniswap's PositionManager has the pool key, and keccak256 of that key is the
//    pool id, so the two currencies are certain. Pools created outside PositionManager (launchpads with
//    their own hooks) are 'price-matched' instead: the pool exists in Uniswap's StateView with
//    liquidity, and its on-chain price matches the claimed pair within 3% (public RPCs refuse the old
//    event logs that would prove the key).
// Every listed meme must also have a KyberSwap route back to USDC, a basic check against tokens that
// can be bought but not sold. None of this makes a meme safe; the pages say so.
import { unstable_cache } from 'next/cache';
import { encodeAbiParameters, getAddress, keccak256, parseAbi } from 'viem';
import { fetchCoinbaseStockList } from './coinbaseStockList';
import { getClient } from './quote';
import { redis } from './redis';
import { CL_FACTORY, STOCKS, USDC, type CbStock } from './tokens';

export const UNISWAP_V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as const;
export const UNISWAP_V4_POSITION_MANAGER = '0x7C5f5A4bBd8fD63184577525326123B519429bDc' as const;
export const UNISWAP_V4_STATE_VIEW = '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71' as const;

/** Listed in the main table at or above this pool liquidity; below it, under "thin". */
export const MEME_MIN_LIQUIDITY_USD = 10_000;
/** Pools under this are not listed at all. */
export const MEME_THIN_LIQUIDITY_USD = 1_000;

const POOLS_KEY = 'memes:pools';
const DEX = 'https://api.dexscreener.com';
const KYBER = 'https://aggregator-api.kyberswap.com/base/api/v1';

// Majors and stablecoins are the "money" side of a pool, never the meme.
const NOT_MEMES = new Set(
  [
    USDC.address,
    '0x4200000000000000000000000000000000000006', // WETH
    '0x0000000000000000000000000000000000000000', // native ETH (v4)
    '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
    '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT
    '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', // EURC
    '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
    '0xe5020A6d073a794B6E7f05678707dE47986Fb0b6', // frxUSD
  ].map((a) => a.toLowerCase()),
);
/** Stablecoins we have not listed by address still read as money, not memes ("frxUSD", "EURC"). */
const STABLE_SYMBOL = /USD|EUR/i;

export type MemeVenue = 'aerodrome' | 'uniswap-v3' | 'uniswap-v4';
export type MemeVerification = 'proven' | 'price-matched';

export interface MemePool {
  /** Pool contract (Aerodrome, Uniswap v3) or 32-byte pool id (Uniswap v4), lowercase. */
  id: string;
  venue: MemeVenue;
  stockSymbol: string;
  meme: { address: `0x${string}`; symbol: string; name: string; decimals: number };
  verification: MemeVerification;
  /** Uniswap v4 hook contract when known and not empty (launchpads attach their own). */
  hooks: string | null;
  createdAt: number | null;
}

export interface MemeAllowlist {
  checkedAt: number;
  pools: MemePool[];
}

/** Names and symbols are chosen by whoever launched the token: keep them short and printable. */
function clean(s: unknown, max: number): string {
  return typeof s === 'string' ? s.replace(/[^\p{L}\p{N}\p{P}\p{Zs}$+<=>^`|~]/gu, '').trim().slice(0, max) : '';
}

// ---------------------------------------------------------------- Dexscreener

interface DexPair {
  pairAddress: string;
  dexId: string;
  labels?: string[] | null;
  priceNative?: string;
  priceUsd?: string;
  volume?: { h24?: number; h6?: number; h1?: number };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  liquidity?: { usd?: number; base?: number; quote?: number };
  pairCreatedAt?: number | null;
  marketCap?: number | null;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
}

async function dex<T>(path: string, revalidate: number | 'no-store'): Promise<T> {
  const res = await fetch(`${DEX}${path}`, {
    headers: { accept: 'application/json' },
    ...(revalidate === 'no-store' ? { cache: 'no-store' as const } : { next: { revalidate } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Dexscreener ${res.status}`);
  return (await res.json()) as T;
}

/** Live pair data for up to any number of pools, 30 per request (Dexscreener's limit). */
async function dexPairs(ids: string[], revalidate: number | 'no-store'): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const json = await dex<{ pairs?: DexPair[] | null }>(`/latest/dex/pairs/base/${chunk.join(',')}`, revalidate);
    for (const p of json.pairs ?? []) out.set(p.pairAddress.toLowerCase(), p);
  }
  return out;
}

// ---------------------------------------------------------------- on-chain checks

const POOL_ABI = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)',
]);
const CL_FACTORY_ABI = parseAbi(['function getPool(address, address, int24) view returns (address)']);
const V3_FACTORY_ABI = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)']);
const POSM_ABI = parseAbi([
  'function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
]);
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ZERO = '0x0000000000000000000000000000000000000000';

async function tokenMeta(address: `0x${string}`) {
  const client = getClient();
  const [decimals, symbol, name] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address, abi: ERC20_ABI, functionName: 'name' }).catch(() => ''),
  ]);
  const cleanName = clean(name, 40);
  // A symbol made only of emoji or control characters cleans to nothing: fall back to the name, then the address.
  const cleanSymbol = clean(symbol, 20) || cleanName.slice(0, 20) || `${address.slice(0, 6)}…${address.slice(-4)}`;
  return { decimals: Number(decimals), symbol: cleanSymbol, name: cleanName };
}

/** Aerodrome Slipstream or Uniswap v3: the factory must know this exact pool for these two tokens. */
async function verifyContractPool(pool: `0x${string}`, venue: 'aerodrome' | 'uniswap-v3', stock: CbStock, meme: `0x${string}`): Promise<boolean> {
  const client = getClient();
  const [factory, token0, token1] = await Promise.all(
    (['factory', 'token0', 'token1'] as const).map((fn) => client.readContract({ address: pool, abi: POOL_ABI, functionName: fn })),
  );
  const pair = [token0, token1].map((t) => t.toLowerCase()).sort().join();
  if (pair !== [stock.tokenAddress, meme].map((t) => t.toLowerCase()).sort().join()) return false;
  if (venue === 'aerodrome') {
    if (!same(factory, CL_FACTORY)) return false;
    const spacing = await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'tickSpacing' });
    return same(await client.readContract({ address: CL_FACTORY, abi: CL_FACTORY_ABI, functionName: 'getPool', args: [token0, token1, spacing] }), pool);
  }
  if (!same(factory, UNISWAP_V3_FACTORY)) return false;
  const fee = await client.readContract({ address: pool, abi: POOL_ABI, functionName: 'fee' });
  return same(await client.readContract({ address: UNISWAP_V3_FACTORY, abi: V3_FACTORY_ABI, functionName: 'getPool', args: [token0, token1, fee] }), pool);
}

/** Uniswap v4: proven through PositionManager's pool key, else price-matched against StateView. */
async function verifyV4Pool(
  id: `0x${string}`,
  stock: CbStock,
  meme: `0x${string}`,
  memeDecimals: number,
  claimedStockPerMeme: number,
): Promise<{ verification: MemeVerification; hooks: string | null } | null> {
  const client = getClient();
  const key = await client.readContract({ address: UNISWAP_V4_POSITION_MANAGER, abi: POSM_ABI, functionName: 'poolKeys', args: [id.slice(0, 52) as `0x${string}`] });
  const [currency0, currency1, fee, tickSpacing, hooks] = key;
  if (!same(currency0, ZERO) || !same(currency1, ZERO)) {
    const encoded = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [currency0, currency1, fee, tickSpacing, hooks],
    );
    const pair = [currency0, currency1].map((t) => t.toLowerCase()).sort().join();
    if (keccak256(encoded) === id && pair === [stock.tokenAddress, meme].map((t) => t.toLowerCase()).sort().join()) {
      return { verification: 'proven', hooks: same(hooks, ZERO) ? null : getAddress(hooks) };
    }
    return null;
  }
  // Not in PositionManager: the pool must exist with liquidity, and its price must be the claimed pair's.
  const [[sqrtPriceX96], liquidity] = await Promise.all([
    client.readContract({ address: UNISWAP_V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [id] }),
    client.readContract({ address: UNISWAP_V4_STATE_VIEW, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [id] }),
  ]);
  if (sqrtPriceX96 === BigInt(0) || liquidity === BigInt(0) || !(claimedStockPerMeme > 0)) return null;
  const memeIs0 = meme.toLowerCase() < stock.tokenAddress.toLowerCase();
  const [dec0, dec1] = memeIs0 ? [memeDecimals, stock.decimals] : [stock.decimals, memeDecimals];
  const ratio = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = ratio * ratio * 10 ** (dec0 - dec1);
  const stockPerMeme = memeIs0 ? token1PerToken0 : 1 / token1PerToken0;
  if (Math.abs(stockPerMeme / claimedStockPerMeme - 1) > 0.03) return null;
  return { verification: 'price-matched', hooks: null };
}

/** True when KyberSwap can route about $20 of the meme back to USDC. */
async function hasSellRoute(meme: `0x${string}`, decimals: number, priceUsd: number): Promise<boolean> {
  if (!(priceUsd > 0)) return false;
  const units = BigInt(Math.max(1, Math.floor((20 / priceUsd) * 10 ** Math.min(decimals, 18))));
  const params = new URLSearchParams({ tokenIn: meme, tokenOut: USDC.address, amountIn: units.toString() });
  const res = await fetch(`${KYBER}/routes?${params}`, { headers: { 'x-client-id': 'afterbook' }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  const json = (await res.json().catch(() => null)) as { data?: { routeSummary?: { amountOut?: string } } } | null;
  return res.ok && BigInt(json?.data?.routeSummary?.amountOut ?? '0') > BigInt(0);
}

// ---------------------------------------------------------------- discovery (daily job)

export interface DiscoveryReport {
  candidates: number;
  listed: number;
  rejected: { id: string; symbol: string; reason: string }[];
}

/** Finds and verifies every meme pool on a tracked stock. Reads only; the caller saves the result. */
export async function discoverMemePools(): Promise<{ allowlist: MemeAllowlist; report: DiscoveryReport }> {
  // Any Coinbase tokenized stock on the other side is a stock pair, not a meme.
  const coinbase = new Set((await fetchCoinbaseStockList({ cache: 'no-store' })).map((t) => String(t.contract_address ?? '').toLowerCase()));

  const candidates: { pair: DexPair; stock: CbStock; meme: `0x${string}` }[] = [];
  for (const stock of STOCKS) {
    const pairs = await dex<DexPair[]>(`/token-pairs/v1/base/${stock.tokenAddress}`, 'no-store').catch(() => []);
    for (const pair of pairs) {
      const stockIsBase = same(pair.baseToken.address, stock.tokenAddress);
      if (!stockIsBase && !same(pair.quoteToken.address, stock.tokenAddress)) continue;
      const other = (stockIsBase ? pair.quoteToken : pair.baseToken).address.toLowerCase();
      if (NOT_MEMES.has(other) || coinbase.has(other)) continue;
      if (STABLE_SYMBOL.test((stockIsBase ? pair.quoteToken : pair.baseToken).symbol ?? '')) continue;
      if ((pair.liquidity?.usd ?? 0) < MEME_THIN_LIQUIDITY_USD) continue;
      candidates.push({ pair, stock, meme: getAddress(other) });
    }
  }

  const pools: MemePool[] = [];
  const rejected: DiscoveryReport['rejected'] = [];
  const seen = new Set<string>();
  for (const { pair, stock, meme } of candidates) {
    const id = pair.pairAddress.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const label = (pair.labels ?? []).join(',');
    const venue: MemeVenue | null =
      pair.dexId === 'aerodrome' && id.length === 42 ? 'aerodrome' : pair.dexId === 'uniswap' && id.length === 66 ? 'uniswap-v4' : pair.dexId === 'uniswap' && id.length === 42 && label.includes('v3') ? 'uniswap-v3' : null;
    const reject = (reason: string) => rejected.push({ id, symbol: clean(same(pair.baseToken.address, meme) ? pair.baseToken.symbol : pair.quoteToken.symbol, 20), reason });
    if (!venue) {
      reject(`unsupported venue ${pair.dexId}${label ? ` (${label})` : ''}`);
      continue;
    }
    try {
      const meta = await tokenMeta(meme);
      let verification: MemeVerification = 'proven';
      let hooks: string | null = null;
      if (venue === 'uniswap-v4') {
        // priceNative is the base token's price in quote units.
        const native = Number(pair.priceNative);
        const stockPerMeme = same(pair.baseToken.address, meme) ? native : native > 0 ? 1 / native : 0;
        const v4 = await verifyV4Pool(id as `0x${string}`, stock, meme, meta.decimals, stockPerMeme);
        if (!v4) {
          reject('pool not verified on-chain');
          continue;
        }
        ({ verification, hooks } = v4);
      } else if (!(await verifyContractPool(getAddress(id), venue, stock, meme))) {
        reject('pool not verified on-chain');
        continue;
      }
      const memePriceUsd = same(pair.baseToken.address, meme) ? Number(pair.priceUsd) : NaN;
      if (!(await hasSellRoute(meme, meta.decimals, memePriceUsd).catch(() => false))) {
        reject('no route back to USDC');
        continue;
      }
      pools.push({ id, venue, stockSymbol: stock.symbol, meme: { address: meme, ...meta }, verification, hooks, createdAt: pair.pairCreatedAt ?? null });
    } catch {
      reject('on-chain read failed');
    }
  }
  return { allowlist: { checkedAt: Date.now(), pools }, report: { candidates: candidates.length, listed: pools.length, rejected } };
}

export async function saveMemeAllowlist(list: MemeAllowlist): Promise<void> {
  if (!redis) return;
  await redis.set(POOLS_KEY, JSON.stringify(list));
}

async function fetchAllowlist(): Promise<MemeAllowlist | null> {
  if (!redis) return null;
  const raw = await redis.get<MemeAllowlist | string>(POOLS_KEY);
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as MemeAllowlist) : raw;
}

// An hour in Next's data cache: page views don't each cost a Redis request (CLAUDE.md, Redis budget).
const cachedAllowlist = unstable_cache(fetchAllowlist, ['memes-allowlist'], { revalidate: 60 * 60 });

export async function getMemeAllowlist(): Promise<MemeAllowlist | null> {
  try {
    return await cachedAllowlist();
  } catch (err) {
    console.error('[memes] could not read the allowlist', err);
    return null;
  }
}

// ---------------------------------------------------------------- the board (pages and card)

export interface MemeMove {
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export interface MemeRow {
  pool: MemePool;
  priceUsd: number | null;
  volume24Usd: number | null;
  liquidityUsd: number | null;
  /** Stock tokens sitting in the pool, and their value at the pool's own stock price. */
  stockInPool: number | null;
  stockInPoolUsd: number | null;
  marketCapUsd: number | null;
  move: MemeMove;
  stockMove: MemeMove;
  thin: boolean;
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function rowFrom(pool: MemePool, pair: DexPair | undefined, stockPair: DexPair | undefined): MemeRow {
  const memeIsBase = !!pair && same(pair.baseToken.address, pool.meme.address);
  const stockInPool = pair ? num(memeIsBase ? pair.liquidity?.quote : pair.liquidity?.base) : null;
  // The stock's USD price from its own USDC pool; the pool's priceUsd is the base token's.
  const stockUsd = stockPair ? Number(stockPair.priceUsd) : NaN;
  const liquidityUsd = num(pair?.liquidity?.usd);
  return {
    pool,
    priceUsd: pair && memeIsBase ? num(Number(pair.priceUsd)) : null,
    volume24Usd: num(pair?.volume?.h24),
    liquidityUsd,
    stockInPool,
    stockInPoolUsd: stockInPool != null && stockUsd > 0 ? stockInPool * stockUsd : null,
    marketCapUsd: memeIsBase ? num(pair?.marketCap) : null,
    // Dexscreener's change is for the base token; a meme quoted the other way round has no clean number.
    move: memeIsBase ? { h1: num(pair?.priceChange?.h1), h6: num(pair?.priceChange?.h6), h24: num(pair?.priceChange?.h24) } : { h1: null, h6: null, h24: null },
    stockMove: { h1: num(stockPair?.priceChange?.h1), h6: num(stockPair?.priceChange?.h6), h24: num(stockPair?.priceChange?.h24) },
    thin: (liquidityUsd ?? 0) < MEME_MIN_LIQUIDITY_USD,
  };
}

async function loadBoard(): Promise<{ rows: MemeRow[]; checkedAt: number } | null> {
  const list = await getMemeAllowlist();
  if (!list) return null;
  // Our stocks' own Aerodrome USDC pools give each stock's USD price and its move over the same windows.
  const stockPools = STOCKS.map((s) => s.pool.address.toLowerCase());
  const live = await dexPairs([...list.pools.map((p) => p.id), ...stockPools], 120);
  const byStock = new Map(STOCKS.map((s) => [s.symbol, live.get(s.pool.address.toLowerCase())]));
  const rows = list.pools
    .map((p) => rowFrom(p, live.get(p.id), byStock.get(p.stockSymbol)))
    .filter((r) => (r.liquidityUsd ?? 0) >= MEME_THIN_LIQUIDITY_USD);
  // One row per meme token: the deepest of its stock pools.
  const best = new Map<string, MemeRow>();
  for (const r of rows) {
    const k = r.pool.meme.address.toLowerCase();
    const prev = best.get(k);
    if (!prev || (r.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) best.set(k, r);
  }
  return { rows: [...best.values()].sort((a, b) => (b.volume24Usd ?? 0) - (a.volume24Usd ?? 0)), checkedAt: list.checkedAt };
}

// Two minutes in Next's data cache, so pages, cards and the swap routes (which check a meme's live
// liquidity on every quote) share one Dexscreener read instead of each making their own. A failure throws
// inside, so it is not cached.
const cachedBoard = unstable_cache(
  async () => {
    const board = await loadBoard();
    if (!board) throw new Error('meme allowlist unavailable');
    return board;
  },
  ['memes-board'],
  { revalidate: 120 },
);

/** Every listed meme, busiest first (never "recommended"). Null when the allowlist or Dexscreener is unavailable. */
export async function getMemeBoard(): Promise<{ rows: MemeRow[]; checkedAt: number } | null> {
  try {
    return await cachedBoard();
  } catch (err) {
    console.error('[memes] could not build the board', err);
    return null;
  }
}

export async function getMemeRow(address: string): Promise<MemeRow | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const board = await getMemeBoard();
  return board?.rows.find((r) => same(r.pool.meme.address, address)) ?? null;
}

/** A tracked-meme address is the only kind the swap may buy (see lib/swap.ts). */
export async function findListedMeme(address: string): Promise<MemePool | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const list = await getMemeAllowlist();
  return list?.pools.find((p) => same(p.meme.address, address)) ?? null;
}

export function venueLabel(v: MemeVenue): string {
  return v === 'aerodrome' ? 'Aerodrome' : v === 'uniswap-v3' ? 'Uniswap v3' : 'Uniswap v4';
}

/** Where to see the pool itself. */
export function poolUrl(pool: MemePool): string {
  return `https://dexscreener.com/base/${pool.id}`;
}
