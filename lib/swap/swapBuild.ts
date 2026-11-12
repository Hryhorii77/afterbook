// The server half of in-app swaps: asks KyberSwap's aggregator for a route and a transaction (with
// Afterbook's registered client id, kyberClient.ts) and checks it with checkSwapCalldata before any
// browser sees it. Server-only, so neither the client id nor this code can end up in a browser bundle;
// what browsers need (the router address, limits, types, the pure checks) stays in swap.ts.
import 'server-only';
import { getAddress, type Hex } from 'viem';
import type { CbStock } from '../stocks/tokens';
import { getCachedPoolState, poolDepth } from '../market/quote';
import { KYBER_SOURCE, kyberHeaders, redactKyber } from './kyberClient';
import {
  checkSwapCalldata,
  KYBER_ROUTER,
  MAX_BUY_DEPTH_SHARE,
  MAX_MEME_SWAP_USD,
  MAX_SWAP_USD,
  SwapError,
  swapFee,
  tokensFor,
  type SwapFee,
  type SwapQuote,
  type SwapRequest,
  type SwapTx,
} from './swap';

const KYBER_API = 'https://aggregator-api.kyberswap.com/base/api/v1';

/** Afterbook's fee for this request: never on a meme buy (the owner has not decided one), else swapFee(). */
function feeFor(req: SwapRequest): SwapFee | null {
  return req.meme ? null : swapFee();
}

async function kyber<T>(path: string, init?: { body: unknown }): Promise<T> {
  const res = await fetch(`${KYBER_API}${path}`, {
    method: init ? 'POST' : 'GET',
    headers: kyberHeaders(Boolean(init)),
    body: init ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
  // KyberSwap's message describes our request (e.g. "route not found"); it is passed on, with the client
  // id blanked out in case an auth or rate-limit error ever quotes it.
  if (!res.ok || !json?.data) throw new SwapError(json?.message ? `KyberSwap: ${redactKyber(String(json.message)).slice(0, 120)}` : `KyberSwap answered ${res.status}`);
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

/** Builds the swap transaction for `account` and refuses it unless the decoded calldata is exactly
 *  what was asked for: router, function, tokens, recipient, amount, a floor within our slippage of the
 *  quote, Afterbook's fee (or none) and no permit. The browser only ever sees a transaction that passed. */
export async function buildSwap(req: SwapRequest, account: `0x${string}`): Promise<SwapTx> {
  const fee = feeFor(req);
  const { summary, quote } = await getRoute(req, fee);
  const built = await kyber<{ amountIn: string; amountOut: string; data: Hex; routerAddress: string; transactionValue: string }>(
    '/route/build',
    { body: { routeSummary: summary, sender: account, recipient: account, slippageTolerance: req.slippageBps, source: KYBER_SOURCE } },
  );
  if (getAddress(built.routerAddress) !== KYBER_ROUTER) throw new SwapError('unexpected router');
  if (built.transactionValue !== '0') throw new SwapError('swap must not send ETH');

  const minAmountOut = checkSwapCalldata(req, account, fee, built.data, BigInt(summary.amountOut));
  return { quote, to: KYBER_ROUTER, data: built.data, minAmountOut: minAmountOut.toString(), spender: KYBER_ROUTER, tokenIn: tokensFor(req).tokenIn };
}

