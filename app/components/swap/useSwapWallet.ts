'use client';

// The wallet side of every in-app swap, shared by the four swap panels (SwapPanel: one stock;
// MemeBuyPanel: one meme; BasketBuyPanel and BasketSellPanel: one swap per /build leg) and by
// Portfolio's Revoke (RouterApprovals: revokeRouter, an approval of zero). It holds the
// rules that must be the same everywhere, so they live in one place:
// - approvals are for the exact amount, only for KyberSwap's router, never unlimited;
// - every approval and swap carries Afterbook's Builder Code (approve: `dataSuffix`; the swap goes
//   through sendTransaction, which has none, so the suffix is appended with `concat`);
// - a swap is only sent to the router (the server already checked the calldata, lib/swap/swap.ts), and
//   only if the browser's own checks pass too (lib/swap/swapFloor.ts): the calldata is the trade asked
//   for, its signed minimum is the one shown and within the person's slippage of the quote, and a stock
//   quote is no more than 1% worse than that stock's own pool would pay for the same amount, walked through
//   the pool's liquidity read from the chain here, not from the server;
// - a transaction that reverts onchain is an error, never a success;
// - a one-signature basket batch (sendBatch, lib/swap/basketBatch.ts) is sent only atomically, to a wallet
//   that says it can do that on Base, and its calls come only from basketBatchCalls (or basketSellBatchCalls);
//   a single stock swap from such a wallet is the same kind of batch, its exact approval and its swap (2026-11-24);
//   the Aave panels' one-signature batches go through the same send (sendCheckedBatch) with their own check
//   (lib/lending/aaveBatch.ts);
// - a single swap is dry-run on Base just before the wallet sees it (simulateSwapCalls): one that would revert
//   gets one fresh route and another dry run, and is never sent while it still reverts (owner, 2026-11-24: a
//   real /rules swap reverted inside KyberSwap's route and the paymaster still charged its fee).
// Each panel keeps its own review card, wording and progress; this file never decides what to trade.

import { useEffect, useState } from 'react';
import { useAccount, useCapabilities, useConfig, usePublicClient, useReadContract, useSendCalls, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi';
import { getPublicClient, waitForCallsStatus } from 'wagmi/actions';
import { base } from 'wagmi/chains';
import { concat, erc20Abi, getAddress, parseUnits, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/wallet/builderCode';
import { KYBER_ROUTER, type SwapQuote, type SwapTx } from '@/lib/swap/swap';
import { basketBatchCalls, basketBatchProblem, basketSellBatchCalls, canBatchAtomically, type BatchCall } from '@/lib/swap/basketBatch';
import { userOpOutcome } from '@/lib/wallet/userOps';
import { dryRunVerdict, type DryRun } from '@/lib/swap/dryRun';
import { wagmiConfig } from '@/lib/wallet/wagmiConfig';
import { getStock, USDC } from '@/lib/stocks/tokens';
import { poolFillProblem, signedFloorProblem } from '@/lib/swap/swapFloor';
import { readPoolState } from '@/lib/market/quote';
import { getLiquidityDistribution } from '@/lib/market/depth';
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

/** Calls /api/swap/build and refuses the answer unless the wallet would be pointed at the router, the
 *  calldata is the trade asked for with the minimum shown (within the slippage setting of the quote),
 *  and, for a stock, the quote is at most 1% worse than its own pool would pay for this amount, read here. */
export async function buildSwap(body: {
  amountIn: string;
  account: `0x${string}` | undefined;
  slippageBps: number;
  symbol?: string;
  side?: 'buy' | 'sell';
  /** A meme buy: the meme's address, and the token it is paid with (USDC or its pool's stock token). */
  meme?: `0x${string}`;
  payToken?: `0x${string}`;
  [k: string]: unknown;
}): Promise<SwapTx> {
  const account = body.account;
  if (!account) throw new Error('Connect a wallet first.');
  // The tokens the calldata must trade, from the person's own request, never from the server's answer.
  const stock = body.symbol ? getStock(body.symbol) : undefined;
  const usdc = USDC.address as `0x${string}`;
  const tokens = stock
    ? body.side === 'sell'
      ? { tokenIn: stock.tokenAddress, tokenOut: usdc }
      : { tokenIn: usdc, tokenOut: stock.tokenAddress }
    : body.meme && body.payToken
      ? { tokenIn: body.payToken, tokenOut: body.meme }
      : null;
  if (!tokens || (stock && body.side !== 'buy' && body.side !== 'sell')) throw new Error('Refused: unknown trade.');
  const { payToken: _payToken, ...request } = body;
  void _payToken;
  const tx = await api<SwapTx>('/api/swap/build', { body: request });
  if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
  const floor = signedFloorProblem(tx, { amountIn: body.amountIn, account, slippageBps: body.slippageBps, ...tokens });
  if (floor) throw new Error(`Refused: ${floor}. This swap was not sent.`);
  if (stock) {
    if (tx.quote.symbol !== stock.symbol || tx.quote.side !== body.side) throw new Error('Refused: the server built a different trade. This swap was not sent.');
    // The stock's own pool, read here from public RPC (never the server), walked for exactly this amount.
    const pool = await (async () => {
      const client = getPublicClient(wagmiConfig, { chainId: base.id }) as unknown as Parameters<typeof readPoolState>[1];
      const state = await readPoolState(stock, client);
      return { state, dist: await getLiquidityDistribution(stock, state, client, true) };
    })().catch(() => {
      throw new Error(`Couldn't read ${stock.symbol}'s pool to check the quote. This swap was not sent; try again.`);
    });
    const gap = poolFillProblem(tx, stock, pool.state, pool.dist);
    if (gap) throw new Error(`Refused: ${gap}. This swap was not sent.`);
  }
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

  /** Whether a transaction was sent by someone other than the connected account: a smart account's
   *  bundler (or the account isn't known: then nothing can be told). A regular wallet sends its own, and
   *  its "Speed up" or "Cancel" is followed as before. */
  const sentByBundler = (from: `0x${string}`) => !address || getAddress(from) !== getAddress(address);

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
    let byBundler = false;
    let replaced: 'cancelled' | 'replaced' | 'repriced' | null = null;
    const receipt = await client().waitForTransactionReceipt({
      hash,
      onReplaced: (r) => {
        replaced = r.reason;
        byBundler = sentByBundler(r.replacedTransaction.from);
      },
    });
    // Replaced, for a smart account: viem matched another transaction from the bundler's shared account
    // with the same nonce, which says nothing about this approval.
    if (byBundler) throw new Error(TX_UNKNOWN);
    // A regular wallet's own Cancel: nothing was approved; another replacement: unknown.
    if (replaced === 'cancelled') throw new Error(revertedMessage);
    if (replaced === 'replaced') throw new Error(TX_UNKNOWN);
    // A smart account's approval is a user operation inside a bundler's transaction: that one can succeed
    // while the approval reverted, so the account's own operation decides.
    const outcome = userOpOutcome(receipt, address);
    if (outcome === 'reverted') throw new Error(revertedMessage);
    if (outcome === 'unknown') throw new Error(TX_UNKNOWN);
    // The block that holds the approval: a dry run right after must see it (simulateSwapCalls' `atLeastBlock`).
    return receipt.blockNumber;
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
    let byBundler = false;
    const receipt = await client().waitForTransactionReceipt({
      hash,
      onReplaced: (r) => {
        replaced = r.reason;
        byBundler = sentByBundler(r.replacedTransaction.from);
      },
    });
    // A smart account's swap is sent by a bundler: a "replacement" is just another transaction from its
    // shared account with the same nonce (a bundler's self-send reads as "cancelled"), which says nothing
    // about this swap; it may still be bundled again. Never "cancelled" (that would free a rule run).
    if (byBundler) throw new Error(TX_UNKNOWN);
    if (replaced === 'cancelled') throw new Error(SWAP_CANCELLED);
    if (replaced === 'replaced') throw new Error(SWAP_REPLACED);
    // Same for a smart account's swap: the bundler's transaction succeeding doesn't mean the swap ran.
    const outcome = userOpOutcome(receipt, address);
    if (outcome === 'reverted') throw new Error(revertedMessage);
    if (outcome === 'unknown') throw new Error(TX_UNKNOWN);
    return receipt.transactionHash;
  };

  /** Sends a basket batch (calls from basketBatchCalls or basketSellBatchCalls only) as one atomic EIP-5792 batch and waits for it.
   *  Returns the mined transaction hashes. `onSigned` runs once the wallet has accepted it. A batch that
   *  failed is BATCH_FAILED when the wallet confirms it was atomic (nothing happened), otherwise
   *  BATCH_UNKNOWN; so is one whose outcome can't be read in time (it may still go through). */
  const sendBatch = async (calls: BatchCall[], onSigned?: (id: string) => void): Promise<Hex[]> => {
    // Every call checked again: every swap pays this account, every approval is exactly what the batch's swaps spend of that token.
    if (!address) throw new Error('Connect a wallet first.');
    return sendCheckedBatch(calls, basketBatchProblem, onSigned);
  };

  /** The atomic send shared by every one-signature batch: `check` is the batch's own rule (the swap batch's
   *  basketBatchProblem, the Aave panels' aaveBatchProblem), run here against this hook's own connected account;
   *  any reason it returns refuses the batch before the wallet sees it. */
  const sendCheckedBatch = async (calls: BatchCall[], check: (calls: BatchCall[], account: `0x${string}`) => string | null, onSigned?: (id: string) => void): Promise<Hex[]> => {
    if (!address) throw new Error('Connect a wallet first.');
    const problem = check(calls, address);
    if (problem) throw new Error(`Refused: ${problem}.`);
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

  /** Dry-runs calls from the connected account on Base now (eth_simulateV1), exactly as they would be sent.
   *  'reverts' only when the node ran them and one failed; a node that can't simulate is 'unknown', which
   *  never blocks a swap (the old behaviour). */
  const simulateSwapCalls = async (calls: BatchCall[], atLeastBlock?: bigint): Promise<DryRun> => {
    if (!address) return 'unknown';
    try {
      // Right after an approval, a node that hasn't seen its block yet would run the swap without it and report a
      // revert: then wait (briefly) for that block, and if the node still hasn't got it, don't block on its answer.
      if (atLeastBlock != null) {
        let head = await client().getBlockNumber({ cacheTime: 0 });
        for (let i = 0; i < 4 && head < atLeastBlock; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          head = await client().getBlockNumber({ cacheTime: 0 });
        }
        if (head < atLeastBlock) return 'unknown';
      }
      return dryRunVerdict(await client().simulateCalls({ account: address, calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value })) }));
    } catch (error) {
      return dryRunVerdict({ error });
    }
  };

  /** Sets the router's allowance for `token` back to zero (Portfolio's Revoke): approve(router, 0). */
  const revokeRouter = async (token: `0x${string}`, revertedMessage: string, onSigned?: () => void) => {
    await ensureBase();
    await approveExact(token, BigInt(0), revertedMessage, onSigned);
  };

  return { address, ensureBase, routerAllowance, approveExact, sendSwap, revokeRouter, canBatch, sendBatch, sendCheckedBatch, simulateSwapCalls };
}

/** Wording for a run that stops: what the panel says and what the toast says. */
export interface RunTexts {
  declined: string;
  declinedTitle: string;
  declinedBody: string;
  failedTitle: string;
}

/** USDC (raw) to leave in a Base Account wallet (`canBatch`): it takes its network fee in USDC from the same wallet
 *  after the calls run, on one-signature and two-step sends alike, so spending the whole balance can pass the dry run and still fail
 *  (2026-11-24 review: about 1–2 cents a batch; 5 cents leaves room). */
export const USDC_FEE_RESERVE_RAW = BigInt(50_000);
/** What to keep back from `balance` for the fee, never below zero. */
export const afterFeeReserve = (balance: bigint) => (balance > USDC_FEE_RESERVE_RAW ? balance - USDC_FEE_RESERVE_RAW : BigInt(0));
export const FEE_RESERVE_NOTE = 'Base Account takes its network fee in USDC from this wallet: leave about $0.05 of USDC so this can go through.';

export const SWAP_CANCELLED = 'The swap was cancelled in your wallet. Nothing was bought or sold.';
export const BATCH_FAILED = 'The basket’s transaction reverted onchain, so nothing was bought and nothing was approved; only the network fee was paid. Prices may have moved: review it again.';
export const BATCH_UNKNOWN = 'Your wallet sent the basket, but its outcome couldn’t be read yet. Check your wallet activity before buying again.';
export const TX_UNKNOWN = 'Your wallet sent it, but whether it went through couldn’t be read. Check your wallet activity before trying again.';
export const SWAP_REPLACED = 'Your wallet replaced the swap with another transaction. Check your wallet activity to see what went through.';
export const ROUTE_WOULD_FAIL =
  'This swap would fail right now: it reverts in a dry run on Base, even with a fresh route. Nothing was sent, so it cost no network fee. Try again in a moment.';
export const ROUTE_WOULD_FAIL_AFTER_APPROVAL =
  'This swap would fail right now: it reverts in a dry run on Base, even with a fresh route, so it wasn’t sent. Only the approval went through; it stays for your next try (no approval needed then). Try again in a moment.';

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
  /** Bookkeeping only, either flow: the wallet has taken the swap (two steps: sent; one signature: the batch
   *  accepted), with no hash needed; and `onStartFailed` once it is known nothing was swapped. */
  onStarted?: (tx: SwapTx) => void;
  onStartFailed?: (tx: SwapTx) => void;
  /** A tracked stock's swap (not a meme) from a wallet that can batch atomically: the exact approval, when
   *  needed, and the swap as one signature (lib/swap/basketBatch.ts). False for a /rules run, whose pending
   *  record needs a transaction hash before the swap is mined (onSent), which a batch doesn't have. */
  oneSignature?: boolean;
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

  const oneSignature = !!opts.oneSignature && wallet.canBatch;

  /** A rebuild held to the reviewed card: the same trade with a minimum at least as good, or the new numbers
   *  are shown and nothing is signed. */
  const rebuildAgainst = async (reviewed: SwapTx, approvalDone: boolean): Promise<SwapTx> => {
    setBusy('rebuild');
    const next = await opts.build();
    if (!opts.sameTrade(next, reviewed) || BigInt(next.minAmountOut) < BigInt(reviewed.minAmountOut)) {
      setReview(next);
      setReviewedAt(Date.now());
      throw new Error(`The price moved since you reviewed it. Check the new numbers and confirm again${approvalDone ? ' (no approval needed this time)' : ''}.`);
    }
    return next;
  };

  /** The calls to dry-run (and, for one signature, to send): the exact approval when `approve`, then the swap. */
  const swapCalls = (tx: SwapTx, approve: boolean): BatchCall[] => {
    if (!approve) return [{ to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0) }];
    return tx.quote.side === 'sell' ? basketSellBatchCalls([tx], [true]) : basketBatchCalls([tx], true);
  };

  /** Dry-runs the swap (with its approval when it goes in the same batch); on a revert, one fresh route, held to
   *  the card, and another dry run. Never returns a swap that still reverts. */
  const passDryRun = async (tx: SwapTx, reviewed: SwapTx, approve: boolean, approvalDone: boolean, approvalBlock?: bigint): Promise<SwapTx> => {
    setBusy('simulate');
    if ((await wallet.simulateSwapCalls(swapCalls(tx, approve), approvalBlock)) !== 'reverts') return tx;
    const next = await rebuildAgainst(reviewed, approvalDone);
    setBusy('simulate');
    if ((await wallet.simulateSwapCalls(swapCalls(next, approve), approvalBlock)) === 'reverts') throw new Error(approvalDone ? ROUTE_WOULD_FAIL_AFTER_APPROVAL : ROUTE_WOULD_FAIL);
    return next;
  };

  const confirmOneSignature = async (reviewed: SwapTx) => {
    const reviewedIn = BigInt(reviewed.quote.amountIn);
    let tx = Date.now() - reviewedAt > 60_000 ? await rebuildAgainst(reviewed, false) : reviewed;
    const approve = (await wallet.routerAllowance(reviewed.tokenIn)) < reviewedIn;
    tx = await passDryRun(tx, reviewed, approve, false);
    const calls = approve ? swapCalls(tx, true) : [{ to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0) }];
    setBusy('swap');
    let signed = false;
    let hashes: Hex[];
    try {
      hashes = await wallet.sendBatch(calls, () => {
        signed = true;
        setReview(null);
        setBusy('confirming');
        opts.onStarted?.(tx);
      });
    } catch (e) {
      const msg = (e as Error).message;
      // Declined or refused before the wallet took it: nothing was sent, the card stays.
      if (!signed) throw e;
      // An atomic batch that reverted did nothing at all; anything else may have gone through.
      if (msg === BATCH_FAILED) {
        opts.onStartFailed?.(tx);
        throw new Error(opts.texts.reverted);
      }
      if (msg === BATCH_UNKNOWN) throw new Error(TX_UNKNOWN);
      throw e;
    }
    opts.onSwapped(tx, hashes[hashes.length - 1]);
  };

  const confirm = () =>
    run('swap', async () => {
      if (!wallet.address || !review) return;
      await wallet.ensureBase();
      if (oneSignature) return confirmOneSignature(review);

      // Everything below uses the reviewed values, never the live input field.
      const reviewedIn = BigInt(review.quote.amountIn);
      let tx = review;
      let stale = Date.now() - reviewedAt > 60_000;
      let approvalDone = false;
      let approvalBlock: bigint | undefined;
      if ((await wallet.routerAllowance(review.tokenIn)) < reviewedIn) {
        setBusy('approve');
        approvalBlock = await wallet.approveExact(review.tokenIn, reviewedIn, opts.texts.approvalReverted);
        stale = true;
        approvalDone = true;
      }
      if (stale) tx = await rebuildAgainst(review, approvalDone);
      tx = await passDryRun(tx, review, false, approvalDone, approvalBlock);

      setBusy('swap');
      let sent: Hex | null = null;
      let hash: Hex;
      try {
        hash = await wallet.sendSwap(tx, opts.texts.reverted, (h) => {
          sent = h;
          setReview(null);
          setBusy('confirming');
          opts.onSent?.(tx, h);
          opts.onStarted?.(tx);
        });
      } catch (e) {
        // Only a mined revert or a wallet cancel is a failure; a receipt that couldn't be read, or an unknown
        // replacement, may still have swapped.
        const msg = (e as Error).message;
        if (sent && (msg === opts.texts.reverted || msg === SWAP_CANCELLED)) {
          opts.onSendFailed?.(tx, sent);
          opts.onStartFailed?.(tx);
        }
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

  return { address: wallet.address, busy, error, review, setReview, done, setDone, startReview, confirm, reset, oneSignature, canBatch: wallet.canBatch };
}
