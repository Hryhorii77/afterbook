import { getClient, TOKEN_ABI, readPoolState, poolDepth } from './quote';
import { STOCKS, USDC, CL_FACTORY, type CbStock } from './tokens';

const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export interface PublishedStock {
  symbol: string;
  tokenAddress: `0x${string}`;
  name: string;
}

// Coinbase's own public, keyless tokenized-stock list. This replaced a scrape of
// base.org/stocks, which turned out to be stale: it listed ten tokens while this
// endpoint lists 58 (including every name the app later added). Each entry
// carries the contract address, so a candidate's identity comes from Coinbase,
// not from a ticker match.
const STOCK_LIST_URL = 'https://api.coinbase.com/v1/tokenized-stocks';
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function fetchPublishedStockList(): Promise<PublishedStock[]> {
  const res = await fetch(STOCK_LIST_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Coinbase tokenized-stocks fetch failed: ${res.status}`);
  const json = (await res.json()) as { tokens?: { symbol?: unknown; contract_address?: unknown; name?: unknown }[] };

  const found = new Map<string, PublishedStock>();
  for (const t of json.tokens ?? []) {
    if (typeof t.symbol !== 'string' || !/^[A-Z0-9]+c$/.test(t.symbol)) continue;
    if (typeof t.contract_address !== 'string' || !ADDRESS_RE.test(t.contract_address)) continue;
    found.set(t.symbol, {
      symbol: t.symbol,
      tokenAddress: t.contract_address as `0x${string}`,
      name: typeof t.name === 'string' ? t.name : '',
    });
  }

  // An empty parse means the response shape changed, not that Coinbase delisted
  // everything — fail so the cron skips the run instead of acting on a false diff.
  if (found.size === 0) throw new Error('no tokens parsed from Coinbase tokenized-stocks response — shape may have changed');
  return [...found.values()];
}

export function diffAgainstTracked(published: PublishedStock[]): PublishedStock[] {
  const tracked = new Set(STOCKS.map((s) => s.symbol));
  return published.filter((p) => !tracked.has(p.symbol));
}

const CL_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'tickSpacing', type: 'int24' },
    ],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

const POOL_META_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint24' }] },
] as const;

// All ten existing pools share this tickSpacing (README-documented, verified
// on-chain per stock) — candidates are checked against the same one rather
// than iterating every possible tick spacing.
const KNOWN_TICK_SPACING = 10;

export interface CandidateResult {
  symbol: string;
  tokenAddress: `0x${string}`;
  /** Real pool depth in USD (same calculation as the tape), or null if there is
   *  no pool or its price state looks broken (an empty pool initialised at a
   *  garbage price reads as astronomically large, so that is rejected). */
  depthUsd: number | null;
  /** null if no Aerodrome pool exists yet through CL_FACTORY at the known
   *  tick spacing — still worth flagging, just not actionable yet. */
  snippet: string | null;
}

/**
 * Verifies a candidate the same way every existing STOCKS entry was
 * verified (decimals/token0/fee/pool, all on-chain) and, if a pool exists,
 * renders a ready-to-paste CbStock object literal — never writes to
 * lib/tokens.ts itself, a human still reviews and adds it.
 */
export async function verifyCandidate(symbol: string, tokenAddress: `0x${string}`, name = ''): Promise<CandidateResult> {
  const client = getClient();

  const [decimalsResult, poolResult] = await client.multicall({
    contracts: [
      { address: tokenAddress, abi: DECIMALS_ABI, functionName: 'decimals' },
      { address: CL_FACTORY, abi: CL_FACTORY_ABI, functionName: 'getPool', args: [tokenAddress, USDC.address, KNOWN_TICK_SPACING] },
    ],
    allowFailure: true,
  });

  if (decimalsResult.status !== 'success') {
    return { symbol, tokenAddress, depthUsd: null, snippet: null };
  }
  const decimals = decimalsResult.result as number;

  const poolAddress = poolResult.status === 'success' ? (poolResult.result as `0x${string}`) : null;
  if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
    return { symbol, tokenAddress, depthUsd: null, snippet: null };
  }

  const [token0Result, feeResult, multiplierResult] = await client.multicall({
    contracts: [
      { address: poolAddress, abi: POOL_META_ABI, functionName: 'token0' },
      { address: poolAddress, abi: POOL_META_ABI, functionName: 'fee' },
      { address: tokenAddress, abi: TOKEN_ABI, functionName: 'multiplier' },
    ],
    allowFailure: true,
  });

  const token0 = token0Result.status === 'success' ? (token0Result.result as `0x${string}`) : null;
  const feePpm = feeResult.status === 'success' ? Number(feeResult.result) : null;
  const hasMultiplier = multiplierResult.status === 'success';

  if (!token0 || feePpm == null) {
    return { symbol, tokenAddress, depthUsd: null, snippet: null };
  }

  const token0Side: CbStock['pool']['token0'] = token0.toLowerCase() === USDC.address.toLowerCase() ? 'USDC' : 'stock';

  const snippet = `{
  // TODO: confirm cashTicker against Yahoo Finance before adding (name is
  // Coinbase's own). Also run the Dexscreener cross-check. multiplier() ${hasMultiplier ? 'present' : 'MISSING — verify before adding'}.
  symbol: '${symbol}',
  cashTicker: '${symbol.replace(/c$/, '')}',
  name: '${name.replace(/'/g, "\\'")}',
  tokenAddress: '${tokenAddress}',
  decimals: ${decimals},
  pool: {
    address: '${poolAddress}',
    token0: '${token0Side}',
    tickSpacing: ${KNOWN_TICK_SPACING},
    feePpm: ${feePpm},
  },
},`;

  let depthUsd: number | null = null;
  try {
    const stock: CbStock = {
      symbol,
      cashTicker: symbol.replace(/c$/, ''),
      name,
      tokenAddress,
      decimals,
      pool: { address: poolAddress, token0: token0Side, tickSpacing: KNOWN_TICK_SPACING, feePpm },
    };
    const total = poolDepth(await readPoolState(stock, client), stock).totalUsd;
    depthUsd = Number.isFinite(total) && total >= 0 && total < 1e10 ? total : null;
  } catch {
    // Depth is context for the digest, not a gate: a failed read just omits it.
  }

  return { symbol, tokenAddress, depthUsd, snippet };
}
