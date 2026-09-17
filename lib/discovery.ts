import { getClient, TOKEN_ABI } from './quote';
import { STOCKS, USDC, CL_FACTORY, type CbStock } from './tokens';

const DECIMALS_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

export interface PublishedStock {
  symbol: string;
  tokenAddress: `0x${string}`;
}

// Coinbase's own canonical list — the page itself says "If a token is not
// on this list, Coinbase did not issue it." Confirmed via plain curl (no JS
// execution) that ticker + BaseScan link are present verbatim in the raw
// server-rendered HTML, via this exact repeating pattern:
//   aria-label="View NVDAc on BaseScan" href="https://basescan.org/token/0xb20..."
const STOCK_LIST_URL = 'https://www.base.org/stocks';
const LINK_PATTERN = /aria-label="View ([A-Z]+c) on BaseScan" href="https:\/\/basescan\.org\/token\/(0x[a-fA-F0-9]{40})"/g;

export async function fetchPublishedStockList(): Promise<PublishedStock[]> {
  const res = await fetch(STOCK_LIST_URL);
  if (!res.ok) throw new Error(`base.org/stocks fetch failed: ${res.status}`);
  const html = await res.text();

  const found = new Map<string, `0x${string}`>();
  for (const match of html.matchAll(LINK_PATTERN)) {
    found.set(match[1], match[2] as `0x${string}`);
  }

  // If the page's markup changed enough that the pattern found nothing,
  // that's a scraper failure, not "Coinbase delisted every stock" — treat
  // it as an error so the cron route can skip the run rather than act on
  // a false empty/mass-diff.
  if (found.size === 0) {
    throw new Error('no tickers found on base.org/stocks — page markup may have changed');
  }

  return [...found.entries()].map(([symbol, tokenAddress]) => ({ symbol, tokenAddress }));
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
export async function verifyCandidate(symbol: string, tokenAddress: `0x${string}`): Promise<CandidateResult> {
  const client = getClient();

  const [decimalsResult, poolResult] = await client.multicall({
    contracts: [
      { address: tokenAddress, abi: DECIMALS_ABI, functionName: 'decimals' },
      { address: CL_FACTORY, abi: CL_FACTORY_ABI, functionName: 'getPool', args: [tokenAddress, USDC.address, KNOWN_TICK_SPACING] },
    ],
    allowFailure: true,
  });

  if (decimalsResult.status !== 'success') {
    return { symbol, tokenAddress, snippet: null };
  }
  const decimals = decimalsResult.result as number;

  const poolAddress = poolResult.status === 'success' ? (poolResult.result as `0x${string}`) : null;
  if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
    return { symbol, tokenAddress, snippet: null };
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
    return { symbol, tokenAddress, snippet: null };
  }

  const token0Side: CbStock['pool']['token0'] = token0.toLowerCase() === USDC.address.toLowerCase() ? 'USDC' : 'stock';

  const snippet = `{
  // TODO: confirm cashTicker/name against Yahoo Finance before adding —
  // not derivable from base.org/stocks alone. multiplier() ${hasMultiplier ? 'present' : 'MISSING — verify before adding'}.
  symbol: '${symbol}',
  cashTicker: '${symbol.replace(/c$/, '')}',
  name: '',
  tokenAddress: '${tokenAddress}',
  decimals: ${decimals},
  pool: {
    address: '${poolAddress}',
    token0: '${token0Side}',
    tickSpacing: ${KNOWN_TICK_SPACING},
    feePpm: ${feePpm},
  },
},`;

  return { symbol, tokenAddress, snippet };
}
