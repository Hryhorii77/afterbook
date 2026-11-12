// In-app swaps (USDC <-> a tracked stock token) through KyberSwap's aggregator. Server-only: every
// route here asks KyberSwap for a quote or a transaction, then checks the transaction field by field
// before the browser may show it to a wallet. Afterbook never holds funds, never signs, and the only
// contract a user is ever asked to call or approve is KYBER_ROUTER below.
//
// Why KyberSwap (spike, 2026-10-13, in the product plan): it routed all 12 then-tracked tokens (Aerodrome
// plus prop AMMs, within about -5 to +8 bp of our Aerodrome-only quote), needed no account or API key
// (an API key for their keyed gateway, KYBERSWAP_API_KEY, came later: kyberClient.ts), takes no protocol fee on swaps, and supports an integrator fee.
import { decodeFunctionData, getAddress, isAddress, parseAbi, type Hex } from 'viem';
import { STOCKS, USDC, type CbStock } from '../stocks/tokens';
import type { MemePool } from '../memes/memestocks';

/** KyberSwap MetaAggregationRouterV2 on Base (verified source on Sourcify). The only contract a swap
 *  transaction may target and the only spender a swap approval may name. */
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const;
/** Default slippage limit, 0.5%: the wallet's transaction reverts rather than fill below quote minus
 *  this. The trader may pick MIN_SLIPPAGE_BPS..MAX_SLIPPAGE_BPS (owner, 2026-11-03: 0.1-1%, default
 *  0.5%, the same for memes); the server builds and checks every swap with the request's value. */
export const SLIPPAGE_BPS = 50;
export const MIN_SLIPPAGE_BPS = 10;
export const MAX_SLIPPAGE_BPS = 100;

/** Untrusted slippage (bp) into a number in range, the default when absent, or the reason it is refused. */
export function parseSlippageBps(input: unknown): number | string {
  if (input === undefined || input === null || input === '') return SLIPPAGE_BPS;
  const n = typeof input === 'number' ? input : typeof input === 'string' && /^[0-9]{1,4}$/.test(input) ? Number(input) : NaN;
  if (!Number.isInteger(n) || n < MIN_SLIPPAGE_BPS || n > MAX_SLIPPAGE_BPS) return `slippageBps must be a whole number from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}`;
  return n;
}
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
  /** A meme buy (lib/swap/memeSwap.ts): the allowlisted meme is the output, paid with USDC or `stock`
   *  (the stock token its pool is priced in). Always side 'buy', never with Afterbook's fee. */
  meme?: { pool: MemePool; payWith: 'USDC' | 'stock' };
  /** The slippage limit this swap is built and checked with, MIN_SLIPPAGE_BPS..MAX_SLIPPAGE_BPS. */
  slippageBps: number;
}

const AMOUNT_RE = /^[0-9]{1,30}$/;

/** Validates untrusted input into a SwapRequest, or returns the reason it is refused. */
export function parseSwapRequest(input: { symbol?: unknown; side?: unknown; amountIn?: unknown; slippageBps?: unknown }): SwapRequest | string {
  const stock = STOCKS.find((s) => s.symbol === input.symbol);
  if (!stock) return 'unknown symbol';
  if (input.side !== 'buy' && input.side !== 'sell') return 'side must be buy or sell';
  if (typeof input.amountIn !== 'string' || !AMOUNT_RE.test(input.amountIn)) return 'amountIn must be a raw integer string';
  const amountIn = BigInt(input.amountIn);
  if (amountIn <= BigInt(0)) return 'amountIn must be above zero';
  const slippageBps = parseSlippageBps(input.slippageBps);
  if (typeof slippageBps === 'string') return slippageBps;
  return { stock, side: input.side, amountIn, slippageBps };
}

export function tokensFor(req: SwapRequest): { tokenIn: `0x${string}`; tokenOut: `0x${string}` } {
  // Checksummed, so every comparison below is against getAddress() output (lib/stocks/tokens.ts mixes cases).
  const usdc = getAddress(USDC.address);
  const stock = getAddress(req.stock.tokenAddress);
  if (req.meme) return { tokenIn: req.meme.payWith === 'USDC' ? usdc : stock, tokenOut: getAddress(req.meme.pool.meme.address) };
  return req.side === 'buy' ? { tokenIn: usdc, tokenOut: stock } : { tokenIn: stock, tokenOut: usdc };
}

/** A refusal or upstream failure whose message is safe to show; `status` is the HTTP status to answer. */
export class SwapError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
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
  // The request's own limit, range-checked again here so a SwapRequest built by hand cannot widen it.
  // The extra 1 bp (always there) absorbs rounding between KyberSwap's minimum and our quote, so at
  // 100 bp a minimum down to 98.99% of the quote passes.
  if (!Number.isInteger(req.slippageBps) || req.slippageBps < MIN_SLIPPAGE_BPS || req.slippageBps > MAX_SLIPPAGE_BPS) throw new SwapError('refused: slippage out of range', 400);
  const floor = (expectedOut * BigInt(10_000 - req.slippageBps - 1)) / BigInt(10_000);
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
