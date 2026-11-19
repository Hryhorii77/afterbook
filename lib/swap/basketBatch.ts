// One-signature basket buys (quest option A, 2026-11-17). A wallet that can send a batch of calls
// atomically on Base (EIP-5792 `wallet_sendCalls` with `atomic` "supported", such as Base Account) gets
// the whole basket as one batch: the exact USDC approval for KyberSwap's router (only when the router
// can't already spend the total) and one checked swap per stock. The person signs once, and the batch
// goes through together or not at all, so a failed batch leaves nothing bought and nothing approved.
// Pure, so the panel and the tests build exactly the same calls; every rule of a single swap still
// holds: approvals are exact and only for the router, swaps go only to the router, and every call
// carries Afterbook's Builder Code.
import { concat, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '../wallet/builderCode';
import { decodeSwapDesc, KYBER_ROUTER, type SwapTx } from './swap';
import { STOCKS, USDC } from '../stocks/tokens';

export interface BatchCall {
  to: `0x${string}`;
  data: Hex;
  value: bigint;
}

/** Throws unless the calldata the wallet will sign is the trade the card shows: it spends exactly the
 *  quoted amount, its minimum received is exactly `minAmountOut` (the "at least" figure), and its split
 *  amounts don't add up to more than it spends. The server's own check covers this only when the server is honest. */
function assertSignedIsShown(tx: SwapTx): void {
  const d = decodeSwapDesc(tx.data);
  if (!d) throw new Error('Refused: a swap that does not decode.');
  if (d.amountIn !== BigInt(tx.quote.amountIn)) throw new Error('Refused: the swap spends a different amount than shown.');
  if (d.minReturn !== BigInt(tx.minAmountOut)) throw new Error('Refused: the swap’s minimum is not the one shown.');
  if (d.srcAmountsTotal > d.amountIn) throw new Error('Refused: the swap’s split amounts exceed what it spends.');
}

/**
 * The calls of a basket buy batch, in order: approve(router, total) when `approve` is true, then each
 * swap. Throws if a swap isn't a USDC buy through the router, so a wrong build can never be signed.
 */
export function basketBatchCalls(swaps: SwapTx[], approve: boolean): BatchCall[] {
  if (swaps.length === 0) throw new Error('Refused: nothing to buy.');
  let total = BigInt(0);
  for (const tx of swaps) {
    if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
    if (getAddress(tx.tokenIn) !== getAddress(USDC.address) || tx.quote.side !== 'buy') throw new Error('Refused: a basket buy pays in USDC.');
    assertSignedIsShown(tx);
    total += BigInt(tx.quote.amountIn);
  }
  const calls: BatchCall[] = [];
  if (approve) {
    calls.push({
      to: getAddress(USDC.address),
      data: concat([encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, total] }), BUILDER_CODE_SUFFIX]),
      value: BigInt(0),
    });
  }
  for (const tx of swaps) calls.push({ to: KYBER_ROUTER, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0) });
  return calls;
}

/**
 * The calls of a basket sell batch (2026-11-19), stock by stock: approve(router, exactly that leg's amount)
 * of that stock when `approve[i]` is true, then its swap to USDC. Throws unless every swap is a sell of a
 * different tracked stock through the router, so one batch can't approve or sell anything else.
 */
export function basketSellBatchCalls(swaps: SwapTx[], approve: boolean[]): BatchCall[] {
  if (swaps.length === 0) throw new Error('Refused: nothing to sell.');
  if (approve.length !== swaps.length) throw new Error('Refused: one approval decision per stock.');
  const seen = new Set<string>();
  const calls: BatchCall[] = [];
  swaps.forEach((tx, i) => {
    if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
    const stock = STOCKS.find((s) => s.symbol === tx.quote.symbol);
    if (tx.quote.side !== 'sell' || !stock || getAddress(tx.tokenIn) !== getAddress(stock.tokenAddress)) throw new Error('Refused: a basket sell sells its own stocks.');
    if (seen.has(stock.symbol)) throw new Error('Refused: a stock appears twice.');
    seen.add(stock.symbol);
    assertSignedIsShown(tx);
    if (approve[i]) {
      calls.push({
        to: getAddress(stock.tokenAddress),
        data: concat([encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, BigInt(tx.quote.amountIn)] }), BUILDER_CODE_SUFFIX]),
        value: BigInt(0),
      });
    }
    calls.push({ to: KYBER_ROUTER, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0) });
  });
  return calls;
}

/** Whether a wallet's Base capabilities say it can run a batch atomically right now. "ready" (the wallet
 *  would first upgrade the account, e.g. an EOA to a smart account) is not enough: that is a bigger step
 *  than a basket buy should ask for, so those wallets keep the one-swap-at-a-time flow. */
export function canBatchAtomically(capabilities: unknown): boolean {
  const atomic = (capabilities as { atomic?: { status?: unknown } } | null | undefined)?.atomic;
  return atomic?.status === 'supported';
}

const BATCH_TOKENS = new Set([USDC.address, ...STOCKS.map((s) => s.tokenAddress)].map((a) => getAddress(a)));
const USDC_ADDRESS = getAddress(USDC.address);
const STOCK_TOKENS = new Set(STOCKS.map((s) => getAddress(s.tokenAddress)));

/** A call the wallet may be asked to sign in a basket batch: a swap to the router, or an approval of USDC
 *  or a tracked stock whose spender is the router (checked again just before sending). */
export function isBasketBatchCall(c: BatchCall): boolean {
  if (c.value !== BigInt(0)) return false;
  if (getAddress(c.to) === KYBER_ROUTER) return true;
  if (!BATCH_TOKENS.has(getAddress(c.to))) return false;
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    return d.functionName === 'approve' && getAddress(d.args[0] as string) === KYBER_ROUTER;
  } catch {
    return false;
  }
}

/**
 * The whole batch, just before the wallet sees it: every call passes isBasketBatchCall, every swap decodes,
 * pays `account`, has no fee receiver or fee amount, no permit, a minimum above 0 and split amounts within
 * what it spends, and trades USDC against a tracked stock (exactly one side USDC), and every approval is exactly what the batch's swaps spend of that token (never more,
 * never unlimited), at most one per token. Returns a reason to refuse, or null.
 */
export function basketBatchProblem(calls: BatchCall[], account: `0x${string}`): string | null {
  if (calls.length === 0) return 'nothing to send';
  const spends = new Map<string, bigint>();
  const approvals = new Map<string, bigint>();
  for (const c of calls) {
    if (!isBasketBatchCall(c)) return 'unexpected contract';
    if (getAddress(c.to) === KYBER_ROUTER) {
      const d = decodeSwapDesc(c.data);
      if (!d) return 'a swap that does not decode';
      if (d.recipient !== getAddress(account)) return 'a swap that pays someone else';
      // The fee is 0 (SWAP_FEE_BPS unset): turning it on would refuse every batch here until this is revisited.
      if (d.feeReceivers > 0 || d.feeAmounts > 0) return 'a swap with a fee';
      if (d.permit !== '0x') return 'a swap with a permit';
      if (d.minReturn <= BigInt(0)) return 'a swap with no minimum';
      if (d.srcAmountsTotal > d.amountIn) return 'a swap whose split amounts exceed what it spends';
      const pair = (d.srcToken === USDC_ADDRESS && STOCK_TOKENS.has(d.dstToken)) || (d.dstToken === USDC_ADDRESS && STOCK_TOKENS.has(d.srcToken));
      if (!pair) return 'a swap that is not USDC against a tracked stock';
      spends.set(d.srcToken, (spends.get(d.srcToken) ?? BigInt(0)) + d.amountIn);
    } else {
      const token = getAddress(c.to);
      if (approvals.has(token)) return 'two approvals of one token';
      const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
      approvals.set(token, d.args[1] as bigint);
    }
  }
  for (const [token, amount] of approvals) if (spends.get(token) !== amount) return 'an approval that is not exactly what the swaps spend';
  return null;
}
