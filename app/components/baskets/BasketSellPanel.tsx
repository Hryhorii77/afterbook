'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAccount, useReadContracts } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, getAddress, type Hex } from 'viem';
import { KYBER_ROUTER, type SwapTx } from '@/lib/swap/swap';
import { USDC } from '@/lib/stocks/tokens';
import { basketSellAmounts, legFloor, MIN_LEG_USDC, type BasketLegAmount } from '@/lib/swap/basketBuy';
import { WalletConnectButton } from '../layout/WalletConnectButton';
import { useNotify } from '../notifications/notify';
import { fmt, logSwapHash, usd, venueNames } from '../swap/swapClient';
import { basketSellBatchCalls } from '@/lib/swap/basketBatch';
import { BATCH_FAILED, buildSwap, useSwapWallet, useTxRun } from '../swap/useSwapWallet';
import { SlippageControl, useSlippage } from '../swap/slippage';

// Sell a /build basket: a share of whatever the wallet holds of each of its stocks, one KyberSwap
// swap per stock back to USDC. The mirror of BasketBuyPanel with one difference: each stock is a
// different token, so each needs its own exact approval of the router (two signatures per stock,
// skipped when the allowance already covers it). Every leg is built and checked by /api/swap/build
// like a single sell, rebuilt just before signing and sent only if it still returns at least the
// "at least" USDC on the review card. A stop states what was sold and offers the rest; nothing
// retries on its own.
// A wallet that runs batches atomically on Base (Base Account) signs the whole sale once instead
// (2026-11-19): one batch of, per stock, its exact approval (only if needed) and its swap, through
// basketSellBatchCalls, together or not at all. Same freshness rules as BasketBuyPanel's batch.

const LEG_PAUSE_MS = 4000; // same reason as BasketBuyPanel: let wallet simulations see the last leg
const BATCH_FRESH_MS = 60_000; // as BasketBuyPanel: a review under a minute old is signed as reviewed
const REBUILD_GAP_MS = 1000; // and an older one is rebuilt one leg a second (KyberSwap's rate limit)
const SELL_BATCH_FAILED = 'The sale’s transaction reverted onchain, so nothing was sold and nothing was approved; only the network fee was paid. Prices may have moved: review it again.';
const SELL_BATCH_UNKNOWN = 'Your wallet sent the sale, but its outcome couldn’t be read yet. Check your wallet activity before selling again.';

export interface SellStock {
  symbol: string;
  decimals: number;
  tokenAddress: `0x${string}`;
}

interface Progress {
  symbol: string;
  status: 'waiting' | 'sending' | 'done' | 'stopped';
  hash?: string;
  text?: string;
}

export function BasketSellPanel({ stocks, onBusy }: { stocks: SellStock[]; onBusy?: (busy: boolean) => void }) {
  const { address } = useAccount();
  const { notify } = useNotify();
  const wallet = useSwapWallet();
  const { busy, setBusy, error, run } = useTxRun({
    declined: 'Declined in your wallet. That step was not submitted.',
    declinedTitle: 'Declined',
    declinedBody: 'That step was not submitted.',
    failedTitle: 'Basket sell stopped',
  });

  const [pct, setPct] = useState('100');
  const slippageBps = useSlippage();
  const [review, setReview] = useState<{ plan: BasketLegAmount; tx: SwapTx }[] | null>(null);
  /** When and for which account the review was built: a batch reuses it only within a minute, for the same account. */
  const [reviewMeta, setReviewMeta] = useState<{ at: number; account: `0x${string}` } | null>(null);
  /** A one-signature sale the wallet accepted whose outcome isn't known: it may have gone through. */
  const [maybeSent, setMaybeSent] = useState(false);
  const [progress, setProgress] = useState<Progress[] | null>(null);
  const [rest, setRest] = useState<BasketLegAmount[] | null>(null);
  /** After a stop: the stock the router can still spend, read live from the chain (whatever run approved it). */
  const [approvedLeft, setApprovedLeft] = useState<BasketLegAmount | null>(null);
  /** Stocks left out of the review because they are worth less than MIN_LEG_USDC (dust costs more in gas). */
  const [dust, setDust] = useState<string[]>([]);
  useEffect(() => onBusy?.(busy !== null), [busy, onBusy]);
  // A review is only valid for the slippage limit it was built with.
  useEffect(() => setReview(null), [slippageBps]);
  // Nor for another account: switching accounts drops it (a reused swap would pay the old one).
  useEffect(() => setReview(null), [address]);
  const oneSignature = wallet.canBatch;

  const stockOf = (symbol: string) => stocks.find((s) => s.symbol === symbol)!;
  const { data: balances, refetch: refetchBalances } = useReadContracts({
    contracts: stocks.map((s) => ({ address: s.tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [address!], chainId: base.id }) as const),
    query: { enabled: !!address },
  });
  const holdings = stocks.map((s, i) => ({ symbol: s.symbol, balance: (balances?.[i]?.result as bigint | undefined) ?? BigInt(0) }));
  const pctNum = /^\d{1,3}$/.test(pct) ? Number(pct) : NaN;
  const pctOk = Number.isInteger(pctNum) && pctNum >= 1 && pctNum <= 100;
  const plan = pctOk ? basketSellAmounts(holdings, pctNum) : [];
  const loaded = balances !== undefined;

  const buildLeg = async (leg: BasketLegAmount): Promise<SwapTx> => {
    const tx = await buildSwap({ symbol: leg.symbol, side: 'sell', amountIn: leg.amountIn.toString(), account: address, source: 'basket', slippageBps }).catch((e: Error) => {
      throw /limited to/.test(e.message) ? new Error(`Selling that much ${leg.symbol} is over $25,000 in one swap. Lower the percent.`) : e;
    });
    // buildSwap checked the router; this checks it is the trade asked for: this stock, a sell,
    // exactly this amount, its own token as the input.
    if (tx.quote.symbol !== leg.symbol || tx.quote.side !== 'sell' || tx.quote.amountIn !== leg.amountIn.toString() || getAddress(tx.tokenIn) !== getAddress(stockOf(leg.symbol).tokenAddress)) {
      throw new Error('Refused: the server built a different trade.');
    }
    return tx;
  };

  const startReview = (legs: BasketLegAmount[]) =>
    run('review', async () => {
      setProgress(null);
      const built = [];
      for (const leg of legs) built.push({ plan: leg, tx: await buildLeg(leg) });
      const worth = built.filter((l) => l.tx.quote.amountInUsd >= MIN_LEG_USDC);
      setDust(built.filter((l) => l.tx.quote.amountInUsd < MIN_LEG_USDC).map((l) => l.plan.symbol));
      if (worth.length === 0) throw new Error(`Each stock to sell is worth less than $${MIN_LEG_USDC}: not worth the network fees.`);
      setReview(worth);
      setReviewMeta({ at: Date.now(), account: address! });
    });

  const confirmBatch = () =>
    run('rebuild', async () => {
      if (!address || !review) return;
      await wallet.ensureBase();
      setRest(null);
      setApprovedLeft(null);
      setMaybeSent(false);
      // Over a minute old, or built for another account: every leg rebuilt now and held to its card's
      // "at least" USDC before anything is signed. A fresher one is signed as reviewed.
      const stale = !reviewMeta || Date.now() - reviewMeta.at > BATCH_FRESH_MS || reviewMeta.account.toLowerCase() !== address.toLowerCase();
      const fresh: SwapTx[] = [];
      for (const [i, { plan: leg, tx: reviewed }] of review.entries()) {
        if (!stale) {
          fresh.push(reviewed);
          continue;
        }
        if (i > 0) await new Promise((r) => setTimeout(r, REBUILD_GAP_MS));
        const tx = await buildLeg(leg);
        if (BigInt(tx.minAmountOut) < legFloor(BigInt(reviewed.minAmountOut))) {
          throw new Error(`${leg.symbol}'s price moved below the "at least" amount since your review, so nothing was sent. Review it again.`);
        }
        fresh.push(tx);
      }
      // Each stock's own approval, exactly what its leg sells, only when the router can't already spend it.
      const approve: boolean[] = [];
      for (const { plan: leg } of review) approve.push((await wallet.routerAllowance(stockOf(leg.symbol).tokenAddress)) < leg.amountIn);
      const calls = basketSellBatchCalls(fresh, approve);

      const status: Progress[] = review.map((l) => ({ symbol: l.plan.symbol, status: 'sending' }));
      setProgress([...status]);
      setBusy('batch');
      let signed = false;
      try {
        const hashes = await wallet.sendBatch(calls, () => {
          signed = true;
          setBusy('confirm-batch');
        });
        review.forEach(({ plan: leg }, i) => {
          status[i] = { symbol: leg.symbol, status: 'done', hash: hashes[hashes.length - 1], text: `${fmt(leg.amountIn, stockOf(leg.symbol).decimals)} ${leg.symbol} for about ${fmt(fresh[i].quote.amountOut, USDC.decimals, 2)} USDC` };
        });
        setProgress([...status]);
        for (const h of hashes) void logSwapHash(h);
      } catch (e) {
        const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? '';
        // Refused before the wallet accepted it (declined, or the wallet couldn't take the batch): nothing
        // was sent, so the review stays. Accepted, then an atomic failure: nothing sold or approved.
        // Accepted, anything else: it may have gone through.
        if (!signed) {
          setProgress(null);
          throw e;
        }
        setProgress(review.map((l) => ({ symbol: l.plan.symbol, status: 'stopped' })));
        setReview(null);
        void refetchBalances();
        if (msg === BATCH_FAILED) throw new Error(SELL_BATCH_FAILED);
        setMaybeSent(true);
        throw new Error(SELL_BATCH_UNKNOWN);
      }
      setReview(null);
      void refetchBalances();
      notify({ kind: 'tx', tone: 'success', title: 'Basket sold', body: status.map((s) => s.text).join(' · ') });
    });

  const confirm = () =>
    run('start', async () => {
      if (!address || !review) return;
      await wallet.ensureBase();
      setRest(null);
      setApprovedLeft(null);
      setMaybeSent(false);

      const status: Progress[] = review.map((l) => ({ symbol: l.plan.symbol, status: 'waiting' }));
      setProgress([...status]);
      const legsLeft = () => review.filter((_, j) => status[j].status !== 'done').map((l) => l.plan);
      for (let i = 0; i < review.length; i++) {
        const { plan: leg, tx: reviewed } = review[i];
        const token = stockOf(leg.symbol).tokenAddress;
        status[i] = { ...status[i], status: 'sending' };
        setProgress([...status]);
        try {
          // This stock's own approval: exactly what this leg sells, only the router, never unlimited.
          if ((await wallet.routerAllowance(token)) < leg.amountIn) {
            setBusy(`approve-${i}`);
            await wallet.approveExact(token, leg.amountIn, `The ${leg.symbol} approval reverted onchain. It was not sold; only the network fee was paid.`);
            setBusy(`pause-${i}`);
            await new Promise((res) => setTimeout(res, LEG_PAUSE_MS));
          }
          // Rebuilt just before signing; sent only if it returns at least the card's "at least" USDC.
          setBusy(`leg-${i}`);
          const tx = await buildLeg(leg);
          if (BigInt(tx.minAmountOut) < legFloor(BigInt(reviewed.minAmountOut))) {
            throw new Error(`${leg.symbol}'s price moved below the "at least" amount since your review, so it was not sold.`);
          }
          const hash = await wallet.sendSwap(tx, `${leg.symbol}'s swap reverted onchain (its price may have moved past the limit, or a step in the route failed); that stock did not move, only the network fee was paid.`, () => setBusy(`confirm-${i}`));
          status[i] = { symbol: leg.symbol, status: 'done', hash, text: `${fmt(leg.amountIn, stockOf(leg.symbol).decimals)} ${leg.symbol} for about ${fmt(tx.quote.amountOut, USDC.decimals, 2)} USDC` };
          setProgress([...status]);
          void logSwapHash(hash);
          if (i < review.length - 1) {
            setBusy(`pause-${i + 1}`);
            await new Promise((res) => setTimeout(res, LEG_PAUSE_MS));
          }
        } catch (e) {
          status[i] = { ...status[i], status: 'stopped' };
          setProgress([...status]);
          setRest(legsLeft());
          // Whatever approved it (this run, an earlier one, a reverted approval): show what the router can
          // really still spend of this stock, read now, not what we think we approved.
          const open = await wallet.routerAllowance(token).catch(() => BigInt(0));
          setApprovedLeft(open > BigInt(0) ? { symbol: leg.symbol, amountIn: open } : null);
          setReview(null);
          void refetchBalances();
          throw e;
        }
      }
      setReview(null);
      void refetchBalances();
      notify({ kind: 'tx', tone: 'success', title: 'Basket sold', body: status.map((s) => s.text).join(' · ') });
    });

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet on Base to sell this basket.</p>
        <WalletConnectButton />
      </>
    );
  }

  const n = review?.length ?? 0;
  const label = (() => {
    if (!busy) return null;
    if (busy === 'review') return 'Preparing…';
    if (busy === 'start') return 'Starting…';
    if (busy === 'rebuild') return 'Getting the latest prices…';
    if (busy === 'batch') return 'Confirm in your wallet (one signature)…';
    if (busy === 'confirm-batch') return 'Confirming onchain…';
    const [kind, idx] = busy.split('-');
    const sym = review?.[Number(idx)]?.plan.symbol ?? '';
    if (kind === 'approve') return `Approve ${sym} in wallet…`;
    if (kind === 'pause') return `Getting ${sym} ready…`;
    if (kind === 'leg') return `Confirm ${sym} sale in wallet (${Number(idx) + 1} of ${n})…`;
    return `Confirming ${sym} onchain…`;
  })();
  const sold = progress?.filter((p) => p.status === 'done') ?? [];
  const totalOut = review?.reduce((s, l) => s + legFloor(BigInt(l.tx.minAmountOut)), BigInt(0)) ?? BigInt(0);
  const feeBps = review?.[0]?.tx.quote.feeBps ?? 0;

  return (
    <div className="swap-panel">
      <p className="geo-note" style={{ marginTop: 0 }}>
        You hold:{' '}
        {!loaded ? '…' : holdings.some((h) => h.balance > BigInt(0)) ? holdings.map((h) => `${fmt(h.balance, stockOf(h.symbol).decimals)} ${h.symbol}`).join(' · ') : 'none of these stocks'}
      </p>
      <div className="basket-row">
        <input
          inputMode="numeric"
          aria-label="Percent of your holdings to sell"
          placeholder="% to sell"
          className="basket-amount"
          value={pct}
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
            setPct(next);
            setReview(null);
          }}
          disabled={busy !== null}
        />
        <span className="geo-note" style={{ margin: 0, alignSelf: 'center' }}>
          % of what you hold
        </span>
        {!review && (
          <button type="button" className="btn" onClick={() => startReview(plan)} disabled={busy !== null || plan.length === 0}>
            {label ?? 'Review'}
          </button>
        )}
      </div>
      {!pctOk && pct !== '' && <p className="geo-note">Enter a whole percent from 1 to 100.</p>}
      {!review && <SlippageControl disabled={busy !== null} />}
      {loaded && pctOk && plan.length === 0 && <p className="geo-note">Your wallet holds none of these stocks on Base, so there is nothing to sell.</p>}
      {dust.length > 0 && <p className="geo-note">Left out, worth under ${MIN_LEG_USDC} each: {dust.join(', ')}.</p>}
      {plan.length > 0 && !review && (
        <p className="geo-note">
          Sells {pctNum}% of what you hold: {plan.map((l) => `${fmt(l.amountIn, stockOf(l.symbol).decimals)} ${l.symbol}`).join(' · ')}, one swap each, to
          USDC. That includes any you bought outside this basket.
        </p>
      )}

      {review && (
        <div className="swap-review">
          <dl>
            {review.map(({ plan: leg, tx }) => (
              <div key={leg.symbol} style={{ display: 'contents' }}>
                <dt>{leg.symbol}</dt>
                <dd>
                  {fmt(leg.amountIn, stockOf(leg.symbol).decimals, stockOf(leg.symbol).decimals)} {leg.symbol} → about {fmt(tx.quote.amountOut, USDC.decimals, 6)} USDC
                  ({usd(tx.quote.amountOutUsd)}), at least {fmt(legFloor(BigInt(tx.minAmountOut)), USDC.decimals, 6)} · {venueNames(tx.quote.venues)}
                </dd>
              </div>
            ))}
            <dt>You get</dt>
            <dd>
              at least {fmt(totalOut, USDC.decimals, 2)} USDC from {n} swaps
            </dd>
            <dt>Slippage limit</dt>
            <dd>{slippageBps / 100}% per swap. The &ldquo;at least&rdquo; amounts above allow another 0.5% for prices moving between swaps.</dd>
            <dt>Afterbook fee</dt>
            <dd>{feeBps > 0 ? `${(feeBps / 100).toFixed(2)}% of each swap` : 'none'}</dd>
            <dt>Contract</dt>
            <dd>
              <a href={`https://basescan.org/address/${KYBER_ROUTER}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                KyberSwap router {KYBER_ROUTER.slice(0, 6)}…{KYBER_ROUTER.slice(-4)}&nbsp;<span className="ext-arrow">↗</span>
              </a>
            </dd>
          </dl>
          {oneSignature ? (
            <p className="geo-note">
              You sign once. Your wallet gets one batch: for each stock, approve exactly the amount above for this router (left out if it already can),
              then its swap to USDC: {n} stock{n === 1 ? '' : 's'}. After a minute the prices are fetched again before you sign, and the batch is only sent if
              every stock still returns at least the USDC above. It goes through together or not at all. Network fees are paid in USDC with Base
              Account (in ETH with other wallets).
            </p>
          ) : (
            <p className="geo-note">
              For each stock your wallet asks to approve exactly the amount above for this router (skipped if it already can), then for the swap: up to{' '}
              {n * 2} requests. Each swap is rebuilt just before you sign it and is only sent if you still get at least the USDC above. If one stops, you keep
              the USDC from what was already sold and can sell the rest. Network fees are paid in ETH on Base, or in USDC with Base Account.
            </p>
          )}
          <div className="basket-row">
            <button type="button" className="btn" onClick={oneSignature ? confirmBatch : confirm} disabled={busy !== null}>
              {label ?? `Sell ${n} stock${n === 1 ? '' : 's'}`}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setReview(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {progress && (
        <ul className="geo-note">
          {progress.map((p) => (
            <li key={p.symbol}>
              {p.symbol}:{' '}
              {p.status === 'done' ? (
                <>
                  sold {p.text}{' '}
                  <a href={`https://basescan.org/tx/${p.hash as Hex}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                    View&nbsp;<span className="ext-arrow">↗</span>
                  </a>
                </>
              ) : p.status === 'sending' ? (
                'in progress'
              ) : maybeSent && oneSignature ? (
                'not confirmed yet'
              ) : (
                'not sold'
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
      {approvedLeft && !busy && (
        <p className="geo-note">
          The router may still be approved to spend {fmt(approvedLeft.amountIn, stockOf(approvedLeft.symbol).decimals)} {approvedLeft.symbol} from your wallet.
          Selling the rest uses it, or you can revoke it on <Link href="/portfolio#approvals" className="emph-link">Portfolio</Link>.
        </p>
      )}
      {rest && rest.length > 0 && !review && (
        <>
          <p className="geo-note">
            {sold.length > 0 ? 'The USDC from what was sold above is in your wallet. ' : ''}Not sold:{' '}
            {rest.map((l) => `${fmt(l.amountIn, stockOf(l.symbol).decimals)} ${l.symbol}`).join(', ')}.
          </p>
          <div className="basket-row">
            <button type="button" className="btn" onClick={() => startReview(rest)} disabled={busy !== null}>
              {label ?? 'Review the rest'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
