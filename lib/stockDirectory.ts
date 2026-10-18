// /stocks: every tokenized stock Coinbase lists, not only the ones the tape tracks. The list comes
// from Coinbase (cached an hour); each untracked token's Aerodrome pool and depth come from the daily
// discover-tokens job, which already measures them and saves one snapshot (`saveDirectoryPools`).
// Nothing here reads the chain or writes Redis on a page view, and the snapshot read is cached an hour.
import { unstable_cache } from 'next/cache';
import { fetchCoinbaseStockList } from './coinbaseStockList';
import { ICON_HOST } from './coinbaseIcons';
import { redis } from './redis';
import { STOCKS } from './tokens';

const POOLS_KEY = 'directory:pools';
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export type DirectoryStatus = 'tracked' | 'pool' | 'none' | 'unchecked';

export interface DirectoryRow {
  symbol: string;
  name: string;
  tokenAddress: string;
  /** Coinbase's icon, only from its own metadata host; null draws the letter tile. */
  iconUrl: string | null;
  status: DirectoryStatus;
  /** Real pool depth in USD: the tape's for tracked rows, the daily job's for the rest. */
  depthUsd: number | null;
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

const RANK: Record<DirectoryStatus, number> = { tracked: 0, pool: 1, unchecked: 2, none: 3 };

/** Tracked first, then small pools, deepest first; the rest by ticker. */
export function sortDirectory(rows: DirectoryRow[]): DirectoryRow[] {
  return [...rows].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || (b.depthUsd ?? -1) - (a.depthUsd ?? -1) || a.symbol.localeCompare(b.symbol),
  );
}

/** The whole directory, or null if Coinbase's list can't be read. `trackedDepth` is the tape's depth by symbol. */
export async function getStockDirectory(trackedDepth: Record<string, number | null>): Promise<{ rows: DirectoryRow[]; checkedAt: number | null } | null> {
  const [list, pools] = await Promise.all([
    fetchCoinbaseStockList({ next: { revalidate: 60 * 60 } }).catch(() => null),
    readDirectoryPools(),
  ]);
  if (!list) return null;

  const tracked = new Map(STOCKS.map((s) => [s.tokenAddress.toLowerCase(), s]));
  const seen = new Set<string>();
  const rows: DirectoryRow[] = [];
  for (const t of list) {
    if (typeof t.symbol !== 'string' || !/^[A-Z0-9]+c$/.test(t.symbol)) continue;
    if (typeof t.contract_address !== 'string' || !ADDRESS_RE.test(t.contract_address)) continue;
    if (seen.has(t.symbol)) continue;
    seen.add(t.symbol);
    const iconUrl = typeof t.icon_url === 'string' && t.icon_url.startsWith(ICON_HOST) ? t.icon_url : null;
    const name = typeof t.name === 'string' ? t.name : '';
    // Tracked means the same contract as lib/tokens.ts, not just the same ticker.
    const stock = tracked.get(t.contract_address.toLowerCase());
    if (stock) {
      rows.push({ symbol: stock.symbol, name: name || stock.name, tokenAddress: stock.tokenAddress, iconUrl, status: 'tracked', depthUsd: trackedDepth[stock.symbol] ?? null });
      continue;
    }
    const p = pools?.pools[t.symbol];
    const status: DirectoryStatus = !p ? 'unchecked' : p.pool ? 'pool' : 'none';
    rows.push({ symbol: t.symbol, name, tokenAddress: t.contract_address, iconUrl, status, depthUsd: p?.depthUsd ?? null });
  }
  if (rows.length === 0) return null;
  return { rows: sortDirectory(rows), checkedAt: pools?.checkedAt ?? null };
}
