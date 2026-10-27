import { fetchCoinbaseStockList } from './coinbaseStockList';
import { parseAbi } from 'viem';
import { getClient, TOKEN_ABI, readPoolState, poolDepth, midPriceUsd, MULTIPLIER_ONE } from './quote';
import { STOCKS, USDC, CL_FACTORY, AERO_CL_FACTORY, type CbStock } from './tokens';

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
// (lib/coinbaseStockList.ts reads every page; the first page alone is 100 of 145 as of 2026-10-14.)
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function fetchPublishedStockList(): Promise<PublishedStock[]> {
  const tokens = await fetchCoinbaseStockList({ cache: 'no-store' });

  const found = new Map<string, PublishedStock>();
  for (const t of tokens) {
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

// Where a stock's USDC pool can be: either CL factory (Aero's, where most stock liquidity moved in
// October 2026, or the older Aerodrome one) at any of these tick spacings. The tracked pools use 10
// on Aero and 1 or 10 on the older factory; a candidate is measured on every pool that exists and
// reported on its deepest, the one the tape would read.
const FACTORIES = [AERO_CL_FACTORY, CL_FACTORY] as const;
const TICK_SPACINGS = [1, 10, 50, 100, 200] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface CandidateResult {
  symbol: string;
  tokenAddress: `0x${string}`;
  /** Real pool depth in USD (same calculation as the tape), or null if there is
   *  no pool or its price state looks broken (an empty pool initialised at a
   *  garbage price reads as astronomically large, so that is rejected). */
  depthUsd: number | null;
  /** The deepest USDC pool on either factory, or null if there is none (or the token didn't read). */
  poolAddress: `0x${string}` | null;
  /** null if no USDC pool exists yet on either factory — still worth flagging, just not actionable yet. */
  snippet: string | null;
  /** The pool as a CbStock, for re-reading its depth (`readDepthUsd`); null without a usable pool. */
  stock: CbStock | null;
}

/** One depth read, the tape's calculation; null if the state looks broken (an empty pool
 *  initialised at a garbage price reads as astronomically large). */
export async function readDepthUsd(stock: CbStock, client = getClient()): Promise<number | null> {
  const total = poolDepth(await readPoolState(stock, client), stock).totalUsd;
  return Number.isFinite(total) && total >= 0 && total < 1e10 ? total : null;
}

const POOL_LIQUIDITY_EVENTS = parseAbi([
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
]);
const BASE_BLOCKS_PER_HOUR = 1800n;
const LOG_CHUNK = 500n;

/**
 * The lowest the pool's depth has been over the last `hours`, valued at today's price: today's
 * depth, walked back through every deposit (Mint) and withdrawal (Burn) in the window. One read
 * can catch liquidity that keeps leaving: on 2026-10-19 a bot moved ~$200k in and out of the LLYc
 * pool for minutes at a time (in half of three hours, out for up to 45 minutes), and a single read
 * reported $254k for a pool that held $49k. Throws if the logs can't be read.
 */
export async function lowestRecentDepthUsd(stock: CbStock, hours = 3, client = getClient()): Promise<number> {
  const state = await readPoolState(stock, client);
  const now = poolDepth(state, stock).totalUsd;
  const stockUsdPerRaw = (midPriceUsd(state, stock) * (Number(state.multiplier) / MULTIPLIER_ONE)) / 10 ** stock.decimals;
  const usdcUsdPerRaw = 1 / 10 ** USDC.decimals;
  const [usdPerRaw0, usdPerRaw1] = stock.pool.token0 === 'USDC' ? [usdcUsdPerRaw, stockUsdPerRaw] : [stockUsdPerRaw, usdcUsdPerRaw];

  const head = await client.getBlockNumber();
  const start = head - BigInt(hours) * BASE_BLOCKS_PER_HOUR;
  const moves: { block: bigint; index: number; usd: number }[] = [];
  for (let from = start; from <= head; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n > head ? head : from + LOG_CHUNK - 1n;
    const logs = await client.getLogs({ address: stock.pool.address as `0x${string}`, events: POOL_LIQUIDITY_EVENTS, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const usd = Number(l.args.amount0 ?? 0n) * usdPerRaw0 + Number(l.args.amount1 ?? 0n) * usdPerRaw1;
      moves.push({ block: l.blockNumber, index: l.logIndex, usd: l.eventName === 'Mint' ? usd : -usd });
    }
  }
  // Newest first: the depth before each move is the depth after it, minus what it added.
  moves.sort((a, b) => (a.block === b.block ? b.index - a.index : a.block > b.block ? -1 : 1));
  let depth = now;
  let lowest = now;
  for (const m of moves) {
    depth -= m.usd;
    lowest = Math.min(lowest, depth);
  }
  return Math.max(0, lowest);
}

/**
 * Verifies a candidate the same way every existing STOCKS entry was
 * verified (decimals/token0/fee/pool, all on-chain) and, if a pool exists,
 * renders a ready-to-paste CbStock object literal — never writes to
 * lib/tokens.ts itself, a human still reviews and adds it.
 */
export async function verifyCandidate(symbol: string, tokenAddress: `0x${string}`, name = ''): Promise<CandidateResult> {
  const client = getClient();

  const lookups = FACTORIES.flatMap((factory) => TICK_SPACINGS.map((tickSpacing) => ({ factory, tickSpacing })));
  const [decimalsResult, poolResults] = await Promise.all([
    client.readContract({ address: tokenAddress, abi: DECIMALS_ABI, functionName: 'decimals' }).then(
      (value) => ({ ok: true as const, value: Number(value) }),
      () => ({ ok: false as const }),
    ),
    client.multicall({
      contracts: lookups.map(({ factory, tickSpacing }) => ({
        address: factory,
        abi: CL_FACTORY_ABI,
        functionName: 'getPool' as const,
        args: [tokenAddress, USDC.address, tickSpacing] as const,
      })),
      allowFailure: true,
    }),
  ]);

  if (!decimalsResult.ok) {
    return { symbol, tokenAddress, depthUsd: null, poolAddress: null, snippet: null, stock: null };
  }
  const decimals = decimalsResult.value;

  const found = lookups.flatMap((lookup, i) => {
    const r = poolResults[i];
    const pool = r.status === 'success' ? (r.result as `0x${string}`) : null;
    return pool && pool !== ZERO_ADDRESS ? [{ ...lookup, pool }] : [];
  });
  if (found.length === 0) {
    return { symbol, tokenAddress, depthUsd: null, poolAddress: null, snippet: null, stock: null };
  }

  const multiplierResult = await client.readContract({ address: tokenAddress, abi: TOKEN_ABI, functionName: 'multiplier' }).then(
    () => true,
    () => false,
  );
  const measured = await Promise.all(
    found.map(async ({ factory, tickSpacing, pool }) => {
      const [token0Result, feeResult] = await client.multicall({
        contracts: [
          { address: pool, abi: POOL_META_ABI, functionName: 'token0' },
          { address: pool, abi: POOL_META_ABI, functionName: 'fee' },
        ],
        allowFailure: true,
      });
      if (token0Result.status !== 'success' || feeResult.status !== 'success') return null;
      const token0Side: CbStock['pool']['token0'] = (token0Result.result as string).toLowerCase() === USDC.address.toLowerCase() ? 'USDC' : 'stock';
      const stock: CbStock = {
        symbol,
        cashTicker: symbol.replace(/c$/, ''),
        name,
        tokenAddress,
        decimals,
        // Aero's fee is dynamic: the configured value is its 0.05% ceiling, the live one is read per quote.
        pool: { address: pool, factory, token0: token0Side, tickSpacing, feePpm: factory === AERO_CL_FACTORY ? 500 : Number(feeResult.result) },
      };
      // Depth is context for the digest, not a gate: a failed read just counts as unknown.
      const depthUsd = await readDepthUsd(stock, client).catch(() => null);
      return { stock, depthUsd };
    }),
  );
  const usable = measured.filter((m): m is NonNullable<typeof m> => m !== null);
  if (usable.length === 0) {
    return { symbol, tokenAddress, depthUsd: null, poolAddress: found[0].pool, snippet: null, stock: null };
  }
  const best = usable.reduce((a, b) => ((b.depthUsd ?? -1) > (a.depthUsd ?? -1) ? b : a));
  const { stock, depthUsd } = best;
  const poolAddress = stock.pool.address;

  const snippet = `{
  // TODO: confirm cashTicker against Yahoo Finance before adding (name is
  // Coinbase's own). Also run the Dexscreener cross-check. multiplier() ${multiplierResult ? 'present' : 'MISSING — verify before adding'}.
  symbol: '${symbol}',
  cashTicker: '${stock.cashTicker}',
  name: '${name.replace(/'/g, "\\'")}',
  tokenAddress: '${tokenAddress}',
  decimals: ${decimals},
  pool: {
    address: '${poolAddress}',
    factory: ${stock.pool.factory === AERO_CL_FACTORY ? 'AERO_CL_FACTORY' : 'CL_FACTORY'},
    token0: '${stock.pool.token0}',
    tickSpacing: ${stock.pool.tickSpacing},
    feePpm: ${stock.pool.feePpm},
  },
},`;

  return { symbol, tokenAddress, depthUsd, poolAddress, snippet, stock };
}
