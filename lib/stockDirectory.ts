// /stocks: every tokenized stock Coinbase lists, not only the ones the tape tracks. The list comes
// from Coinbase (cached an hour); each untracked token's Aerodrome pool and depth come from the daily
// discover-tokens job, which already measures them and saves one snapshot (`saveDirectoryPools`).
// Price, 24h move, volume and value on Base come from Dexscreener's batch token endpoint (cached five
// minutes), and each tracked stock's memes from the /memes board. Nothing here reads the chain or
// writes Redis on a page view, and the snapshot read is cached an hour.
import { unstable_cache } from 'next/cache';
import { fetchCoinbaseStockList } from './coinbaseStockList';
import { ICON_HOST } from './coinbaseIcons';
import { getMemeBoard } from './memestocks';
import { redis } from './redis';
import { STOCKS } from './tokens';

const POOLS_KEY = 'directory:pools';
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export type DirectoryStatus = 'tracked' | 'pool' | 'none' | 'unchecked';

export interface DirectoryMeme {
  symbol: string;
  address: string;
  imageUrl: string | null;
}

export interface DirectoryRow {
  symbol: string;
  name: string;
  tokenAddress: string;
  /** Coinbase's icon, only from its own metadata host; null draws the letter tile. */
  iconUrl: string | null;
  status: DirectoryStatus;
  /** Real pool depth in USD: the tape's for tracked rows, the daily job's for the rest. */
  depthUsd: number | null;
  /** From the token's deepest pool on Base (any venue), via Dexscreener. Null when it has none. */
  priceUsd: number | null;
  change24Pct: number | null;
  volume24Usd: number | null;
  /** Price x tokens in circulation on Base: what exists onchain, not the company's market cap. */
  onBaseUsd: number | null;
  /** Verified memes priced in this stock (/memes), busiest first. */
  memes: DirectoryMeme[];
}

export interface DirectoryPools {
  checkedAt: number;
  pools: Record<string, { pool: string | null; depthUsd: number | null }>;
}

/** Called by the daily discover-tokens job with what it just measured. Never throws. */
export async function saveDirectoryPools(snapshot: DirectoryPools): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(POOLS_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.error('[directory] could not save pool snapshot', err);
  }
}

async function fetchDirectoryPools(): Promise<DirectoryPools | null> {
  if (!redis) return null;
  const raw = await redis.get<DirectoryPools | string>(POOLS_KEY);
  if (!raw) return null;
  return typeof raw === 'string' ? (JSON.parse(raw) as DirectoryPools) : raw;
}

// Next's data cache holds the snapshot for an hour across requests and instances, so page views
// don't each cost a Redis request. A failed read throws inside, so it is not cached.
const cachedDirectoryPools = unstable_cache(fetchDirectoryPools, ['directory-pools'], { revalidate: 60 * 60 });

async function readDirectoryPools(): Promise<DirectoryPools | null> {
  try {
    return await cachedDirectoryPools();
  } catch (err) {
    console.error('[directory] could not read pool snapshot', err);
    return null;
  }
}

interface DexTokenPair {
  priceUsd?: string;
  priceNative?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number | null;
  baseToken: { address: string };
  quoteToken: { address: string };
}

export interface StockMarket {
  priceUsd: number | null;
  change24Pct: number | null;
  volume24Usd: number | null;
  onBaseUsd: number | null;
}

const finite = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Dexscreener's best pair per token, 30 tokens a request. Keyed by lowercase address. */
async function fetchStockMarkets(addresses: string[]): Promise<Record<string, StockMarket>> {
  const out: Record<string, StockMarket> = {};
  const best: Record<string, { liq: number; pair: DexTokenPair; isBase: boolean }> = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/base/${chunk.join(',')}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Dexscreener ${res.status}`);
    const pairs = (await res.json()) as DexTokenPair[];
    const wanted = new Set(chunk.map((a) => a.toLowerCase()));
    for (const pair of pairs) {
      for (const isBase of [true, false]) {
        const a = (isBase ? pair.baseToken : pair.quoteToken).address.toLowerCase();
        if (!wanted.has(a)) continue;
        const liq = pair.liquidity?.usd ?? 0;
        if (!best[a] || liq > best[a].liq) best[a] = { liq, pair, isBase };
      }
    }
  }
  for (const [a, { pair, isBase }] of Object.entries(best)) {
    const price = Number(pair.priceUsd);
    const native = Number(pair.priceNative);
    // Dexscreener prices the base token; a stock quoted the other way is worth price / priceNative.
    const priceUsd = isBase ? finite(price) : native > 0 ? finite(price / native) : null;
    out[a] = {
      priceUsd,
      change24Pct: isBase ? finite(pair.priceChange?.h24) : null,
      volume24Usd: finite(pair.volume?.h24),
      onBaseUsd: isBase ? finite(pair.marketCap) : null,
    };
  }
  return out;
}

const cachedStockMarkets = unstable_cache(fetchStockMarkets, ['stock-markets'], { revalidate: 300 });

const RANK: Record<DirectoryStatus, number> = { tracked: 0, pool: 1, unchecked: 2, none: 3 };

/** Tracked first, then small pools, deepest first; the rest by ticker. */
export function sortDirectory(rows: DirectoryRow[]): DirectoryRow[] {
  return [...rows].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || (b.depthUsd ?? -1) - (a.depthUsd ?? -1) || a.symbol.localeCompare(b.symbol),
  );
}

/** The whole directory, or null if Coinbase's list can't be read. `trackedDepth` is the tape's depth by symbol. */
export async function getStockDirectory(trackedDepth: Record<string, number | null>): Promise<{ rows: DirectoryRow[]; checkedAt: number | null } | null> {
  const [list, pools, board] = await Promise.all([
    fetchCoinbaseStockList({ next: { revalidate: 60 * 60 } }).catch(() => null),
    readDirectoryPools(),
    getMemeBoard(),
  ]);
  if (!list) return null;

  const tokens = list.filter(
    (t) => typeof t.symbol === 'string' && /^[A-Z0-9]+c$/.test(t.symbol) && typeof t.contract_address === 'string' && ADDRESS_RE.test(t.contract_address),
  );
  // Market data is a nice-to-have: the list still renders without it.
  const markets = await cachedStockMarkets(tokens.map((t) => String(t.contract_address).toLowerCase()).sort()).catch((err) => {
    console.error('[directory] market data unavailable', err);
    return {} as Record<string, StockMarket>;
  });

  const memesByStock = new Map<string, DirectoryMeme[]>();
  for (const r of board?.rows ?? []) {
    const list = memesByStock.get(r.pool.stockSymbol) ?? [];
    list.push({ symbol: r.pool.meme.symbol, address: r.pool.meme.address, imageUrl: r.imageUrl });
    memesByStock.set(r.pool.stockSymbol, list);
  }

  const tracked = new Map(STOCKS.map((s) => [s.tokenAddress.toLowerCase(), s]));
  const seen = new Set<string>();
  const rows: DirectoryRow[] = [];
  for (const t of tokens) {
    const symbol = t.symbol as string;
    const address = t.contract_address as string;
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    const iconUrl = typeof t.icon_url === 'string' && t.icon_url.startsWith(ICON_HOST) ? t.icon_url : null;
    const name = typeof t.name === 'string' ? t.name : '';
    const market = markets[address.toLowerCase()] ?? { priceUsd: null, change24Pct: null, volume24Usd: null, onBaseUsd: null };
    // Tracked means the same contract as lib/tokens.ts, not just the same ticker.
    const stock = tracked.get(address.toLowerCase());
    if (stock) {
      rows.push({ symbol: stock.symbol, name: name || stock.name, tokenAddress: stock.tokenAddress, iconUrl, status: 'tracked', depthUsd: trackedDepth[stock.symbol] ?? null, ...market, memes: memesByStock.get(stock.symbol) ?? [] });
      continue;
    }
    const p = pools?.pools[symbol];
    const status: DirectoryStatus = !p ? 'unchecked' : p.pool ? 'pool' : 'none';
    rows.push({ symbol, name, tokenAddress: address, iconUrl, status, depthUsd: p?.depthUsd ?? null, ...market, memes: [] });
  }
  if (rows.length === 0) return null;
  return { rows: sortDirectory(rows), checkedAt: pools?.checkedAt ?? null };
}
