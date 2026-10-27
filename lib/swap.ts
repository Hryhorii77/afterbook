// In-app swaps (USDC <-> a tracked stock token) through KyberSwap's aggregator. Server-only: every
// route here asks KyberSwap for a quote or a transaction, then checks the transaction field by field
// before the browser may show it to a wallet. Afterbook never holds funds, never signs, and the only
// contract a user is ever asked to call or approve is KYBER_ROUTER below.
//
// Why KyberSwap (spike, 2026-10-13, in the product plan): it routed all 12 then-tracked tokens (Aerodrome
// plus prop AMMs, within about -5 to +8 bp of our Aerodrome-only quote), needs no account or API key
// (so there is no new secret), takes no protocol fee on swaps, and supports an integrator fee.
import { decodeFunctionData, getAddress, isAddress, parseAbi, type Hex } from 'viem';
import { STOCKS, USDC, type CbStock } from './tokens';
import type { MemePool } from './memestocks';
import { getCachedPoolState, poolDepth } from './quote';

/** KyberSwap MetaAggregationRouterV2 on Base (verified source on Sourcify). The only contract a swap
 *  transaction may target and the only spender a swap approval may name. */
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const;
const KYBER_API = 'https://aggregator-api.kyberswap.com/base/api/v1';
const CLIENT_ID = 'afterbook';
/** Fixed 0.5%: the wallet's transaction reverts rather than fill below quote minus this. */
export const SLIPPAGE_BPS = 50;
/** Largest single swap the panel builds, in USD. A UX guard, not a security control. */
export const MAX_SWAP_USD = 25_000;
/** A stock buy is also capped at this share of the stock's live pool depth (owner, 2026-10-27): the
 *  18 stocks added that day sit in pools of about $51k, where a $25k buy would move the price a long
 *  way. Pools over $250k are unaffected (the $25k cap is lower). A UX guard like MAX_SWAP_USD. */
export const MAX_BUY_DEPTH_SHARE = 0.1;
/** Memes are thin and most go to zero: a much smaller cap per buy. */
export const MAX_MEME_SWAP_USD = 1_000;

const routerAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
  'function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256, uint256)',
]);

export type SwapSide = 'buy' | 'sell';

export interface SwapFee {
  bps: number;
  recipient: `0x${string}`;
}

/** Afterbook's fee, or null when it is off. Off unless SWAP_FEE_BPS (1-100) and a valid
 *  SWAP_FEE_RECIPIENT are both set: a half-configured fee never reaches a transaction. */
export function swapFee(): SwapFee | null {
  const bps = Number(process.env.SWAP_FEE_BPS?.trim() ?? '0');
  const recipient = process.env.SWAP_FEE_RECIPIENT?.trim() ?? '';
  if (!Number.isInteger(bps) || bps <= 0 || bps > 100 || !isAddress(recipient)) return null;
  return { bps, recipient: getAddress(recipient) };
}

export interface SwapRequest {
  stock: CbStock;
  side: SwapSide;
  /** Raw units of the token being sold (USDC for a buy, the stock token for a sell). */
  amountIn: bigint;
  /** A meme buy (lib/memeSwap.ts): the allowlisted meme is the output, paid with USDC or `stock`
   *  (the stock token its pool is priced in). Always side 'buy', never with Afterbook's fee. */
  meme?: { pool: MemePool; payWith: 'USDC' | 'stock' };
}

const AMOUNT_RE = /^[0-9]{1,30}$/;

/** Validates untrusted input into a SwapRequest, or returns the reason it is refused. */
export function parseSwapRequest(input: { symbol?: unknown; side?: unknown; amountIn?: unknown }): SwapRequest | string {
  const stock = STOCKS.find((s) => s.symbol === input.symbol);
  if (!stock) return 'unknown symbol';
  if (input.side !== 'buy' && input.side !== 'sell') return 'side must be buy or sell';
  if (typeof input.amountIn !== 'string' || !AMOUNT_RE.test(input.amountIn)) return 'amountIn must be a raw integer string';
  const amountIn = BigInt(input.amountIn);
  if (amountIn <= BigInt(0)) return 'amountIn must be above zero';
  return { stock, side: input.side, amountIn };
}

function tokensFor(req: SwapRequest): { tokenIn: `0x${string}`; tokenOut: `0x${string}` } {
  // Checksummed, so every comparison below is against getAddress() output (lib/tokens.ts mixes cases).
  const usdc = getAddress(USDC.address);
  const stock = getAddress(req.stock.tokenAddress);
  if (req.meme) return { tokenIn: req.meme.payWith === 'USDC' ? usdc : stock, tokenOut: getAddress(req.meme.pool.meme.address) };
  return req.side === 'buy' ? { tokenIn: usdc, tokenOut: stock } : { tokenIn: stock, tokenOut: usdc };
}

/** Afterbook's fee for this request: never on a meme buy (the owner has not decided one), else swapFee(). */
function feeFor(req: SwapRequest): SwapFee | null {
  return req.meme ? null : swapFee();
}

/** A refusal or upstream failure whose message is safe to show; `status` is the HTTP status to answer. */
export class SwapError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

async function kyber<T>(path: string, init?: { body: unknown }): Promise<T> {
  const res = await fetch(`${KYBER_API}${path}`, {
    method: init ? 'POST' : 'GET',
    headers: { 'x-client-id': CLIENT_ID, ...(init ? { 'content-type': 'application/json' } : {}) },
    body: init ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  // KyberSwap's message describes our request (e.g. "route not found"), never a key: safe to pass on.
  if (!res.ok || !json?.data) throw new SwapError(json?.message ? `KyberSwap: ${String(json.message).slice(0, 120)}` : `KyberSwap answered ${res.status}`);
  return json.data;
}

interface RouteSummary {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  amountInUsd: string;
  amountOutUsd: string;
  gasUsd: string;
  route: { exchange: string }[][];
  extraFee?: { feeAmount: string; chargeFeeBy: string; isInBps: boolean; feeReceiver: string };
}

export interface SwapQuote {
  /** The stock's symbol, or the meme's for a meme buy. */
  symbol: string;
  /** The meme's address on a meme buy (symbols are not unique among memes). */
  meme?: `0x${string}`;
  side: SwapSide;
  amountIn: string;
  /** Expected output after Afterbook's fee, raw units. */
  amountOut: string;
  amountInUsd: number;
  amountOutUsd: number;
  gasUsd: number;
  feeBps: number;
  /** Venues the route splits across, e.g. ["aerodrome-cl-3", "metric-propamm"]. */
  venues: string[];
}

const usdWhole = (n: number) => `$${Math.floor(n).toLocaleString('en-US')}`;

/** The pool's real depth in USD (the tape's number, from a pool-state read cached 20 s), for the buy
 *  cap. Refuses rather than guessing if the pool can't be read. */
async function poolDepthUsd(stock: CbStock): Promise<number> {
  const state = await getCachedPoolState(stock).catch(() => null);
  const depth = state ? poolDepth(state, stock).totalUsd : NaN;
  if (!Number.isFinite(depth) || depth <= 0) throw new SwapError(`could not read ${stock.symbol}'s pool depth; try again in a moment`, 503);
  return depth;
}

async function getRoute(req: SwapRequest, fee: SwapFee | null): Promise<{ summary: RouteSummary; quote: SwapQuote }> {
  const { tokenIn, tokenOut } = tokensFor(req);
  const params = new URLSearchParams({ tokenIn, tokenOut, amountIn: req.amountIn.toString() });
  if (fee) {
    // Always charged in USDC: on the way in for a buy, on the way out for a sell.
    params.set('feeAmount', String(fee.bps));
    params.set('isInBps', 'true');
    params.set('chargeFeeBy', req.side === 'buy' ? 'currency_in' : 'currency_out');
    params.set('feeReceiver', fee.recipient);
  }
  const data = await kyber<{ routeSummary: RouteSummary; routerAddress: string }>(`/routes?${params}`);
  const summary = data.routeSummary;
  if (getAddress(data.routerAddress) !== KYBER_ROUTER) throw new SwapError('unexpected router');
  if (getAddress(summary.tokenIn) !== tokenIn || getAddress(summary.tokenOut) !== tokenOut || summary.amountIn !== req.amountIn.toString()) {
    throw new SwapError('route does not match the request');
  }
  const usdIn = Number(summary.amountInUsd);
  const cap = req.meme ? MAX_MEME_SWAP_USD : MAX_SWAP_USD;
  if (!(usdIn > 0) || usdIn > cap) throw new SwapError(`${req.meme ? 'meme buys' : 'swaps'} are limited to $${cap.toLocaleString('en-US')} each`, 400);
  if (!req.meme && req.side === 'buy') {
    const depth = await poolDepthUsd(req.stock);
    const depthCap = depth * MAX_BUY_DEPTH_SHARE;
    if (usdIn > depthCap) {
      throw new SwapError(
        `${req.stock.symbol} buys are limited to ${usdWhole(depthCap)} here: ${MAX_BUY_DEPTH_SHARE * 100}% of its pool's ${usdWhole(depth)} liquidity`,
        400,
      );
    }
  }
  return {
    summary,
    quote: {
      symbol: req.meme ? req.meme.pool.meme.symbol : req.stock.symbol,
      ...(req.meme ? { meme: getAddress(req.meme.pool.meme.address) } : {}),
      side: req.side,
      amountIn: summary.amountIn,
      amountOut: summary.amountOut,
      amountInUsd: usdIn,
      amountOutUsd: Number(summary.amountOutUsd),
      gasUsd: Number(summary.gasUsd),
      feeBps: fee?.bps ?? 0,
      venues: [...new Set(summary.route.flat().map((h) => h.exchange))],
    },
  };
}

export async function quoteSwap(req: SwapRequest): Promise<SwapQuote> {
  return (await getRoute(req, feeFor(req))).quote;
}

export interface SwapTx {
  quote: SwapQuote;
  to: typeof KYBER_ROUTER;
  data: Hex;
  /** The decoded floor the router enforces, raw units of the output token. */
  minAmountOut: string;
  /** Spender the user must approve, for exactly amountIn of the input token. */
  spender: typeof KYBER_ROUTER;
  tokenIn: `0x${string}`;
}

/** Builds the swap transaction for `account` and refuses it unless the decoded calldata is exactly
 *  what was asked for: router, function, tokens, recipient, amount, a floor within our slippage of the
 *  quote, Afterbook's fee (or none) and no permit. The browser only ever sees a transaction that passed. */
export async function buildSwap(req: SwapRequest, account: `0x${string}`): Promise<SwapTx> {
  const fee = feeFor(req);
  const { summary, quote } = await getRoute(req, fee);
  const built = await kyber<{ amountIn: string; amountOut: string; data: Hex; routerAddress: string; transactionValue: string }>(
    '/route/build',
    { body: { routeSummary: summary, sender: account, recipient: account, slippageTolerance: SLIPPAGE_BPS, source: CLIENT_ID } },
  );
  if (getAddress(built.routerAddress) !== KYBER_ROUTER) throw new SwapError('unexpected router');
  if (built.transactionValue !== '0') throw new SwapError('swap must not send ETH');

  const minAmountOut = checkSwapCalldata(req, account, fee, built.data, BigInt(summary.amountOut));
  return { quote, to: KYBER_ROUTER, data: built.data, minAmountOut: minAmountOut.toString(), spender: KYBER_ROUTER, tokenIn: tokensFor(req).tokenIn };
}

/** The check every built swap must pass before the browser sees it. Pure, so it is tested directly
 *  with tampered calldata. Returns the decoded minimum received, or throws naming what did not match. */
export function checkSwapCalldata(req: SwapRequest, account: `0x${string}`, fee: SwapFee | null, data: Hex, expectedOut: bigint): bigint {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: routerAbi, data });
  } catch {
    throw new SwapError('refused: not a KyberSwap router swap');
  }
  const desc = decoded.functionName === 'swap' ? decoded.args[0].desc : decoded.args[1];
  const { tokenIn, tokenOut } = tokensFor(req);
  const floor = (expectedOut * BigInt(10_000 - SLIPPAGE_BPS - 1)) / BigInt(10_000);
  const checks: [boolean, string][] = [
    [getAddress(desc.srcToken) === tokenIn, 'input token'],
    [getAddress(desc.dstToken) === tokenOut, 'output token'],
    [getAddress(desc.dstReceiver) === getAddress(account), 'recipient'],
    [desc.amount === req.amountIn, 'amount'],
    [desc.minReturnAmount > BigInt(0) && desc.minReturnAmount >= floor && desc.minReturnAmount <= expectedOut, 'minimum received'],
    [desc.permit === '0x', 'permit'],
    [desc.srcAmounts.reduce((a, b) => a + b, BigInt(0)) <= desc.amount, 'split amounts'],
    [
      fee
        ? desc.feeReceivers.length === 1 &&
          getAddress(desc.feeReceivers[0]) === fee.recipient &&
          desc.feeAmounts.length === 1 &&
          desc.feeAmounts[0] === BigInt(fee.bps)
        : desc.feeReceivers.length === 0 && desc.feeAmounts.length === 0,
      'fee',
    ],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.length) throw new SwapError(`refused: the transaction's ${failed.join(', ')} did not match the request`);
  return desc.minReturnAmount;
}

/** The router call's swap description (tokens, recipient, amount), or null if it is not a router swap.
 *  Used by the swap log for meme buys, whose tokens are checked against the stored build. */
export function decodeSwapDesc(data: Hex): { srcToken: `0x${string}`; dstToken: `0x${string}`; recipient: `0x${string}`; amountIn: bigint; feeReceivers: number } | null {
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data });
    const desc = decoded.functionName === 'swap' ? decoded.args[0].desc : decoded.args[1];
    return { srcToken: getAddress(desc.srcToken), dstToken: getAddress(desc.dstToken), recipient: getAddress(desc.dstReceiver), amountIn: desc.amount, feeReceivers: desc.feeReceivers.length };
  } catch {
    return null;
  }
}

/** Decodes a mined router call for the swap log. Null when it is not a swap between USDC and a
 *  tracked stock token. Extra bytes after the arguments (the Builder Code) are ignored by the decoder. */
export function decodeSwapCall(data: Hex): { stock: CbStock; side: SwapSide; amountIn: bigint; recipient: `0x${string}`; feeRecipient: `0x${string}` | null; feeBps: number } | null {
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data });
    const desc = decoded.functionName === 'swap' ? decoded.args[0].desc : decoded.args[1];
    const src = getAddress(desc.srcToken);
    const dst = getAddress(desc.dstToken);
    const usdc = getAddress(USDC.address);
    const side: SwapSide | null = src === usdc ? 'buy' : dst === usdc ? 'sell' : null;
    const stock = STOCKS.find((s) => s.tokenAddress.toLowerCase() === (side === 'buy' ? dst : src).toLowerCase());
    if (!side || !stock) return null;
    return {
      stock,
      side,
      amountIn: desc.amount,
      recipient: getAddress(desc.dstReceiver),
      feeRecipient: desc.feeReceivers[0] ? getAddress(desc.feeReceivers[0]) : null,
      feeBps: Number(desc.feeAmounts[0] ?? BigInt(0)),
    };
  } catch {
    return null;
  }
}
