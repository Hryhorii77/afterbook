'use client';

// The wallet side of every in-app swap, shared by the four swap panels (SwapPanel: one stock;
// MemeBuyPanel: one meme; BasketBuyPanel and BasketSellPanel: one swap per /build leg) and by
// Portfolio's Revoke (RouterApprovals: revokeRouter, an approval of zero). It holds the
// rules that must be the same everywhere, so they live in one place:
// - approvals are for the exact amount, only for KyberSwap's router, never unlimited;
// - every approval and swap carries Afterbook's Builder Code (approve: `dataSuffix`; the swap goes
//   through sendTransaction, which has none, so the suffix is appended with `concat`);
// - a swap is only sent to the router (the server already checked the calldata, lib/swap/swap.ts);
// - a transaction that reverts onchain is an error, never a success;
// - a one-signature basket batch (sendBatch, lib/swap/basketBatch.ts) is sent only atomically, to a wallet
//   that says it can do that on Base, and its calls come only from basketBatchCalls.
// Each panel keeps its own review card, wording and progress; this file never decides what to trade.

import { useEffect, useState } from 'react';
import { useAccount, useCapabilities, useConfig, usePublicClient, useReadContract, useSendCalls, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForCallsStatus } from 'wagmi/actions';
import { base } from 'wagmi/chains';
import { concat, erc20Abi, getAddress, parseUnits, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/wallet/builderCode';
import { KYBER_ROUTER, type SwapQuote, type SwapTx } from '@/lib/swap/swap';
import { canBatchAtomically, isBasketBatchCall, type BatchCall } from '@/lib/swap/basketBatch';
import { userOpOutcome } from '@/lib/wallet/userOps';
import { useNotify } from '../notifications/notify';
import { api } from './swapClient';

/** A typed amount in raw token units, or null while it is empty, not a number or zero. */
export function parseAmount(text: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d+$/.test(text)) return null;
  try {
    const v = parseUnits(text, decimals);
    return v > BigInt(0) ? v : null;
  } catch {
    return null;
  }
}

/** Calls /api/swap/build and refuses the answer unless the wallet would be pointed at the router. */
export async function buildSwap(body: Record<string, unknown>): Promise<SwapTx> {
  const tx = await api<SwapTx>('/api/swap/build', { body });
  if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
  return tx;
}

/** The connected wallet's balance of one token on Base. */
export function useTokenBalance(token: `0x${string}`) {
  const { address } = useAccount();
  const { data, refetch } = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: !!address },
  });
  return { balance: data, refetchBalance: refetch };
}

export function useSwapWallet() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const config = useConfig();
  const { sendCallsAsync } = useSendCalls();
  // Whether this wallet can sign a basket as one atomic batch on Base (EIP-5792). A wallet that doesn't
  // answer, or answers anything but "supported", keeps the one-swap-at-a-time flow.
  const { data: caps } = useCapabilities({ chainId: base.id, query: { enabled: !!address, retry: false, staleTime: 60_000 } });
  const canBatch = !!address && canBatchAtomically(caps);

  const client = () => {
    if (!publicClient) throw new Error('Base is not reachable right now. Try again in a moment.');
    return publicClient;
  };

  const ensureBase = async () => {
    if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
  };

  /** What the router may spend of `token` from the connected wallet, read from the chain now. */
  const routerAllowance = async (token: `0x${string}`): Promise<bigint> => {
    if (!address) return BigInt(0);
    return (await client().readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [address, KYBER_ROUTER] })) as bigint;
  };

  /** Approves exactly `amount` of `token` for the router and waits for it to be mined.
   *  `onSigned` runs once the wallet has sent it (the router may spend from then on). */
  const approveExact = async (token: `0x${string}`, amount: bigint, revertedMessage: string, onSigned?: () => void) => {
    const hash = await writeContractAsync({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [KYBER_ROUTER, amount],
      chainId: base.id,
      dataSuffix: BUILDER_CODE_SUFFIX,
    });
    onSigned?.();
    const receipt = await client().waitForTransactionReceipt({ hash });
    // A smart account's approval is a user operation inside a bundler's transaction: that one can succeed
    // while the approval reverted, so the account's own operation decides.
    const outcome = userOpOutcome(receipt, address);
    if (outcome === 'reverted') throw new Error(revertedMessage);
    if (outcome === 'unknown') throw new Error(TX_UNKNOWN);
  };

  /** Sends a checked router swap with the Builder Code and waits for it to be mined; returns the hash that
   *  was mined (a wallet's "Speed up" mines the same swap under a new hash). `onSigned` runs once the
   *  wallet has sent it. A wallet "Cancel" is a failure (SWAP_CANCELLED), not a swap; another replacement
   *  is reported as SWAP_REPLACED, since what it did is unknown. */
  const sendSwap = async (tx: SwapTx, revertedMessage: string, onSigned?: (hash: Hex) => void): Promise<Hex> => {
    if (getAddress(tx.to) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
    const hash = await sendTransactionAsync({ to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0), chainId: base.id });
    onSigned?.(hash);
    let replaced: 'cancelled' | 'replaced' | 'repriced' | null = null;
    const receipt = await client().waitForTransactionReceipt({ hash, onReplaced: (r) => void (replaced = r.reason) });
    if (replaced === 'cancelled') throw new Error(SWAP_CANCELLED);
    if (replaced === 'replaced') throw new Error(SWAP_REPLACED);
    // Same for a smart account's swap: the bundler's transaction succeeding doesn't mean the swap ran.
    const outcome = userOpOutcome(receipt, address);
    if (outcome === 'reverted') throw new Error(revertedMessage);
    if (outcome === 'unknown') throw new Error(TX_UNKNOWN);
    return receipt.transactionHash;
  };

  /** Sends a basket batch (calls from basketBatchCalls only) as one atomic EIP-5792 batch and waits for it.
   *  Returns the mined transaction hashes. `onSigned` runs once the wallet has accepted it. A batch that
   *  failed is BATCH_FAILED when the wallet confirms it was atomic (nothing happened), otherwise
   *  BATCH_UNKNOWN; so is one whose outcome can't be read in time (it may still go through). */
  const sendBatch = async (calls: BatchCall[], onSigned?: (id: string) => void): Promise<Hex[]> => {
    for (const c of calls) if (!isBasketBatchCall(c)) throw new Error('Refused: unexpected contract.');
    // The Builder Code twice: on each call (the rule for every transaction here) and as the batch's
    // `dataSuffix` capability, which a smart account appends to its whole operation: that is where Base's
    // attribution reads it for Base Account (docs.base.org, builder codes for app developers). Optional, so
    // a wallet without the capability still sends the batch.
    const { id } = await sendCallsAsync({
      calls,
      chainId: base.id,
      forceAtomic: true,
      capabilities: { dataSuffix: { value: BUILDER_CODE_SUFFIX, optional: true } },
    });
    onSigned?.(id);
    let status;
    try {
      status = await waitForCallsStatus(config, { id, timeout: 180_000 });
    } catch {
      throw new Error(BATCH_UNKNOWN);
    }
    const receipts = status.receipts ?? [];
    if (status.status === 'success' && receipts.length > 0 && receipts.every((r) => r.status === 'success')) {
      // The wallet's receipts can leave out the transaction's `to` and the account's own event, so read
      // each mined transaction from the chain and let the account's user operation decide.
      const hashes = [...new Set(receipts.map((r) => r.transactionHash))];
      let mined: { hash: Hex; outcome: 'success' | 'reverted' | 'unknown' }[];
      try {
        // Waits up to 30 s per transaction: the wallet can report it before our node has the block. No
        // replacement detection: the wallet reports hashes already mined, and viem would otherwise accept
        // any transaction from the bundler's shared account with the same nonce (a cancel or a transfer
        // has no EntryPoint event and would read as success).
        mined = await Promise.all(
          hashes.map(async (hash) => {
            const receipt = await client().waitForTransactionReceipt({ hash, timeout: 30_000, checkReplacement: false });
            return { hash: receipt.transactionHash, outcome: userOpOutcome(receipt, address) };
          }),
        );
      } catch {
        throw new Error(BATCH_UNKNOWN);
      }
      const outcomes = mined.map((m) => m.outcome);
      if (outcomes.every((o) => o === 'success')) return [...new Set(mined.map((m) => m.hash))];
      // One transaction whose account operation reverted: an atomic batch then did nothing at all.
      if (status.atomic && hashes.length === 1 && outcomes[0] === 'reverted') throw new Error(BATCH_FAILED);
      throw new Error(BATCH_UNKNOWN);
    }
    // 400: never sent onchain; 500: reverted as a whole. Anything else (600 is a partial revert) isn't "nothing happened".
    if (status.status === 'failure' && status.atomic && (status.statusCode === 400 || status.statusCode === 500)) throw new Error(BATCH_FAILED);
    throw new Error(BATCH_UNKNOWN);
  };

  /** Sets the router's allowance for `token` back to zero (Portfolio's Revoke): approve(router, 0). */
  const revokeRouter = async (token: `0x${string}`, revertedMessage: string, onSigned?: () => void) => {
    await ensureBase();
    await approveExact(token, BigInt(0), revertedMessage, onSigned);
  };

  return { address, ensureBase, routerAllowance, approveExact, sendSwap, revokeRouter, canBatch, sendBatch };
}

/** Wording for a run that stops: what the panel says and what the toast says. */
export interface RunTexts {
  declined: string;
  declinedTitle: string;
  declinedBody: string;
  failedTitle: string;
}

export const SWAP_CANCELLED = 'The swap was cancelled in your wallet. Nothing was bought or sold.';
export const BATCH_FAILED = 'The basket’s transaction reverted onchain, so nothing was bought and nothing was approved. Prices may have moved: review it again.';
export const BATCH_UNKNOWN = 'Your wallet sent the basket, but its outcome couldn’t be read yet. Check your wallet activity before buying again.';
export const TX_UNKNOWN = 'Your wallet sent it, but whether it went through couldn’t be read. Check your wallet activity before trying again.';
export const SWAP_REPLACED = 'Your wallet replaced the swap with another transaction. Check your wallet activity to see what went through.';

/** Busy label, error line and the try/catch every panel wraps a wallet run in. */
export function useTxRun(texts: RunTexts) {
  const { notify } = useNotify();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? 'failed';
      const declined = /reject|denied/i.test(msg);
      setError(declined ? texts.declined : msg);
      notify(
        declined
          ? { kind: 'tx', tone: 'info', title: texts.declinedTitle, body: texts.declinedBody }
          : { kind: 'tx', tone: 'error', title: texts.failedTitle, body: msg },
      );
    } finally {
      setBusy(null);
    }
  };

  return { busy, setBusy, error, setError, run };
}

/** Live price preview for a single swap: debounced on typing, refreshed every 15 s. `path` is the
 *  /api/swap/quote URL, or null while there is no amount. A failed refresh is its own message, so a
 *  panel can hide it while a review is open and it never reads like the swap failed. */
export function useLiveQuote(path: string | null) {
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api<SwapQuote>(path)
        .then((q) => {
          if (!cancelled) {
            setQuote(q);
            setQuoteError(null);
          }
        })
        .catch((e: Error) => !cancelled && setQuoteError(e.message));
    const first = setTimeout(load, 400);
    const every = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [path]);
  const clearQuote = () => {
    setQuote(null);
    setQuoteError(null);
  };
  return { quote, quoteError, clearQuote };
}

/** A single reviewed swap (SwapPanel, MemeBuyPanel): build a review card, then on confirm approve
 *  exactly the reviewed amount if needed, rebuild if the card is over a minute old or an approval
 *  just confirmed, and send only if the rebuilt trade is the same one with a minimum at least as
 *  good as the card's; otherwise show the new numbers and ask again. */
export function useReviewedSwap(opts: {
  build: () => Promise<SwapTx>;
  /** Same trade as the one reviewed (amount, token, what is bought). */
  sameTrade: (next: SwapTx, reviewed: SwapTx) => boolean;
  texts: RunTexts & { reverted: string; approvalReverted: string };
  onSwapped: (tx: SwapTx, hash: Hex) => void;
  /** Bookkeeping only: the wallet has sent the swap (not yet mined). */
  onSent?: (tx: SwapTx, hash: Hex) => void;
  /** Bookkeeping only: a sent swap was mined and reverted, or cancelled in the wallet (nothing swapped). */
  onSendFailed?: (tx: SwapTx, hash: Hex) => void;
}) {
  const wallet = useSwapWallet();
  const { busy, setBusy, error, setError, run } = useTxRun(opts.texts);
  const [review, setReview] = useState<SwapTx | null>(null);
  const [reviewedAt, setReviewedAt] = useState(0);
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);

  const startReview = () =>
    run('review', async () => {
      setDone(null);
      setReview(await opts.build());
      setReviewedAt(Date.now());
    });

  const confirm = () =>
    run('swap', async () => {
      if (!wallet.address || !review) return;
      await wallet.ensureBase();

      // Everything below uses the reviewed values, never the live input field.
      const reviewedIn = BigInt(review.quote.amountIn);
      let tx = review;
      let stale = Date.now() - reviewedAt > 60_000;
      if ((await wallet.routerAllowance(review.tokenIn)) < reviewedIn) {
        setBusy('approve');
        await wallet.approveExact(review.tokenIn, reviewedIn, opts.texts.approvalReverted);
        stale = true;
      }
      if (stale) {
        setBusy('rebuild');
        tx = await opts.build();
        if (!opts.sameTrade(tx, review) || BigInt(tx.minAmountOut) < BigInt(review.minAmountOut)) {
          setReview(tx);
          setReviewedAt(Date.now());
          throw new Error('The price moved since you reviewed it. Check the new numbers and confirm again (no approval needed this time).');
        }
      }

      setBusy('swap');
      let sent: Hex | null = null;
      let hash: Hex;
      try {
        hash = await wallet.sendSwap(tx, opts.texts.reverted, (h) => {
          sent = h;
          setReview(null);
          setBusy('confirming');
          opts.onSent?.(tx, h);
        });
      } catch (e) {
        // Only a mined revert or a wallet cancel is a failure; a receipt that couldn't be read, or an unknown
        // replacement, may still have swapped.
        const msg = (e as Error).message;
        if (sent && (msg === opts.texts.reverted || msg === SWAP_CANCELLED)) opts.onSendFailed?.(tx, sent);
        throw e;
      }
      opts.onSwapped(tx, hash);
    });

  /** Clears the card and messages, e.g. when what is being traded changes. */
  const reset = () => {
    setReview(null);
    setError(null);
    setDone(null);
  };

  return { address: wallet.address, busy, error, review, setReview, done, setDone, startReview, confirm, reset };
}
