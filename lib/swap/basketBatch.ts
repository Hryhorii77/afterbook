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
import { KYBER_ROUTER, type SwapTx } from './swap';
import { USDC } from '../stocks/tokens';

export interface BatchCall {
  to: `0x${string}`;
  data: Hex;
  value: bigint;
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

/** Whether a wallet's Base capabilities say it can run a batch atomically right now. "ready" (the wallet
 *  would first upgrade the account, e.g. an EOA to a smart account) is not enough: that is a bigger step
 *  than a basket buy should ask for, so those wallets keep the one-swap-at-a-time flow. */
export function canBatchAtomically(capabilities: unknown): boolean {
  const atomic = (capabilities as { atomic?: { status?: unknown } } | null | undefined)?.atomic;
  return atomic?.status === 'supported';
}

/** A call the wallet may be asked to sign in a basket batch: a swap to the router, or an approval of USDC
 *  whose spender is the router (checked again just before sending). */
export function isBasketBatchCall(c: BatchCall): boolean {
  if (c.value !== BigInt(0)) return false;
  if (getAddress(c.to) === KYBER_ROUTER) return true;
  if (getAddress(c.to) !== getAddress(USDC.address)) return false;
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    return d.functionName === 'approve' && getAddress(d.args[0] as string) === KYBER_ROUTER;
  } catch {
    return false;
  }
}
