'use client';

// The one-signature send both Aave panels share (2026-11-24): the exact approval, when needed, and the spoke call
// as one atomic batch from a wallet that runs batches on Base (Base Account), dry-run on Base first, checked by aaveBatchProblem
// (lib/lending/aaveBatch.ts) and sent through useSwapWallet's sendCheckedBatch. Returns the mined hash; an atomic
// revert is the panel's own `reverted` text (the approval was undone too), an unreadable outcome TX_UNKNOWN, and
// anything thrown before the wallet took the batch passes through (nothing was sent).
import { aaveBatchCalls, aaveBatchProblem } from '@/lib/lending/aaveBatch';
import { BATCH_FAILED, BATCH_UNKNOWN, TX_UNKNOWN, type useSwapWallet } from '../swap/useSwapWallet';

export async function sendAaveOneSignature(opts: {
  wallet: ReturnType<typeof useSwapWallet>;
  reserves: { reserveId: number; token: `0x${string}` }[];
  spokeData: `0x${string}`;
  approval: { token: `0x${string}`; amount: bigint } | null;
  reverted: string;
  /** What a dry run that reverts means for this action ("This borrow would revert right now (the price or the limit moved)."). */
  wouldRevert: string;
  repayAllCap?: bigint;
  setBusy: (b: string) => void;
}): Promise<`0x${string}`> {
  const calls = aaveBatchCalls(opts.spokeData, opts.approval);
  // Dry run on Base first (as single swaps do): a batch that would revert isn't sent, so it costs no fee. A
  // node that can't simulate never blocks.
  opts.setBusy('simulate');
  if ((await opts.wallet.simulateSwapCalls(calls)) === 'reverts') throw new Error(`${opts.wouldRevert} Nothing was sent, so it cost no network fee.`);
  opts.setBusy('sign');
  let signed = false;
  try {
    const hashes = await opts.wallet.sendCheckedBatch(calls, (c, account) => aaveBatchProblem(c, account, opts.reserves, opts.repayAllCap), () => {
      signed = true;
      opts.setBusy('confirming');
    });
    return hashes[hashes.length - 1];
  } catch (e) {
    const msg = (e as Error).message;
    if (!signed) throw e;
    if (msg === BATCH_FAILED) throw new Error(opts.reverted);
    if (msg === BATCH_UNKNOWN) throw new Error(TX_UNKNOWN);
    throw e;
  }
}
