'use client';

import { useEffect, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { concat, erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/builderCode';
import { KYBER_ROUTER, type SwapTx } from '@/lib/swap';
import { USDC } from '@/lib/tokens';
import type { BasketLeg } from '@/lib/customBasket';
import { basketAmountProblem, legFloor, splitBasketUsdc, type BasketLegAmount } from '@/lib/basketBuy';
import { WalletConnectButton } from './WalletConnectButton';
import { useNotify } from './notify';
import { api, fmt, logSwapHash, usd, venueNames } from './swapClient';

// Buy a /build basket in one go: one USDC amount, split by the basket's weights, one KyberSwap swap
// per stock. Every leg is built and checked by the server exactly like a single swap (lib/swap.ts);
// the wallet approves exactly the basket's total for the router once, then signs one swap per leg,
// each with Afterbook's Builder Code. A leg is rebuilt just before it is signed and only sent if its
// minimum is at least the "at least" figure on the review card. Anything that stops the run stops
// it: what was bought is stated, nothing is retried on its own.

/** Pause after each confirmed leg before asking for the next. On the owner's first real basket
 *  (2026-10-14) Rabby simulated the second swap a moment after the first confirmed and showed a false
 *  "TRANSFER_FROM_FAILED": its simulation counted the first swap twice (pending and mined), so it saw
 *  no allowance left. The same swap simulated fine on-chain and went through seconds later. */
const LEG_PAUSE_MS = 4000;

interface StockInfo {
  symbol: string;
  decimals: number;
}

type LegStatus = 'waiting' | 'sending' | 'done' | 'stopped';
interface Progress {
  symbol: string;
  status: LegStatus;
  hash?: string;
  text?: string;
}
interface Review {
  legs: { plan: BasketLegAmount; tx: SwapTx }[];
}

export function BasketBuyPanel({ legs, stocks, onBusy }: { legs: BasketLeg[]; stocks: StockInfo[]; onBusy?: (busy: boolean) => void }) {
  const { address, chainId } = useAccount();
  const { notify } = useNotify();
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [amount, setAmount] = useState('100');
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress[] | null>(null);
  /** Legs not bought yet after a run stopped: "Buy the rest" reviews just these. */
  const [rest, setRest] = useState<BasketLegAmount[] | null>(null);
  /** This run approved the router: if it then stops before every leg is bought, say what is left approved. */
  const [approvedFor, setApprovedFor] = useState<BasketLegAmount[] | null>(null);
  // Lets the page lock its Buy/Sell switch and eligibility box while a run is asking the wallet.
  useEffect(() => onBusy?.(busy !== null), [busy, onBusy]);

  const decimalsOf = (symbol: string) => stocks.find((s) => s.symbol === symbol)?.decimals ?? 8;

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: !!address },
  });
  const { refetch: refetchAllowance } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, KYBER_ROUTER] : undefined,
    chainId: base.id,
    query: { enabled: !!address },
  });

  const totalRaw = (() => {
    if (!/^\d*\.?\d+$/.test(amount)) return null;
    try {
      const v = parseUnits(amount, USDC.decimals);
      return v > BigInt(0) ? v : null;
    } catch {
      return null;
    }
  })();
  const plan = totalRaw ? splitBasketUsdc(totalRaw, legs) : null;
  const problem = totalRaw ? basketAmountProblem(totalRaw, legs) : null;
  const overBalance = totalRaw !== null && balance !== undefined && totalRaw > balance;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? 'failed';
      const declined = /reject|denied/i.test(msg);
      setError(declined ? 'Declined in your wallet. That step was not submitted.' : msg);
      notify(declined ? { kind: 'tx', tone: 'info', title: 'Declined', body: 'That step was not submitted.' } : { kind: 'tx', tone: 'error', title: 'Basket buy stopped', body: msg });
    } finally {
      setBusy(null);
    }
  };

  const buildLeg = async (leg: BasketLegAmount): Promise<SwapTx> => {
    const tx = await api<SwapTx>('/api/swap/build', {
      body: { symbol: leg.symbol, side: 'buy', amountIn: leg.amountIn.toString(), account: address, source: 'basket' },
    });
    // The server already checked the calldata; this guards the one thing the wallet is pointed at.
    if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
    if (tx.quote.symbol !== leg.symbol || tx.quote.side !== 'buy' || tx.quote.amountIn !== leg.amountIn.toString()) throw new Error('Refused: the server built a different trade.');
    return tx;
  };

  const startReview = (legsToBuy: BasketLegAmount[]) =>
    run('review', async () => {
      setProgress(null);
      const built = [];
      for (const leg of legsToBuy) built.push({ plan: leg, tx: await buildLeg(leg) });
      setReview({ legs: built });
    });

  const confirm = () =>
    run('approve', async () => {
      if (!address || !review || !publicClient) return;
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });

      // Exactly the reviewed total, never unlimited, and only ever for the router.
      const total = review.legs.reduce((s, l) => s + l.plan.amountIn, BigInt(0));
      const { data: allowance } = await refetchAllowance();
      setRest(null);
      setApprovedFor(null);
      if ((allowance ?? BigInt(0)) < total) {
        const approval = await writeContractAsync({
          address: USDC.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [KYBER_ROUTER, total],
          chainId: base.id,
          dataSuffix: BUILDER_CODE_SUFFIX,
        });
        // From here the router may spend the total, so a stop before any leg is bought still says so.
        setApprovedFor(review.legs.map((l) => l.plan));
        const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approval });
        if (approvalReceipt.status !== 'success') throw new Error('The USDC approval reverted onchain. Nothing was bought.');
      }

      const status: Progress[] = review.legs.map((l) => ({ symbol: l.plan.symbol, status: 'waiting' }));
      setProgress([...status]);
      const legsLeft = () => review.legs.filter((_, j) => status[j].status !== 'done').map((l) => l.plan);
      for (let i = 0; i < review.legs.length; i++) {
        const { plan: leg, tx: reviewed } = review.legs[i];
        status[i] = { ...status[i], status: 'sending' };
        setProgress([...status]);
        try {
          // Rebuilt just before signing (prices move between legs). Sent only if it is the same trade
          // with a minimum at or above the review card's "at least" figure for this leg.
          setBusy(`leg-${i}`);
          const tx = await buildLeg(leg);
          if (BigInt(tx.minAmountOut) < legFloor(BigInt(reviewed.minAmountOut))) {
            throw new Error(`${leg.symbol}'s price moved below the "at least" amount since your review, so it was not bought.`);
          }
          const hash = await sendTransactionAsync({ to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0), chainId: base.id });
          setBusy(`confirm-${i}`);
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== 'success') throw new Error(`${leg.symbol}'s swap reverted onchain (its price moved past the limit); that USDC did not move.`);
          status[i] = { symbol: leg.symbol, status: 'done', hash, text: `${fmt(tx.quote.amountOut, decimalsOf(leg.symbol))} ${leg.symbol} for ${fmt(leg.amountIn, USDC.decimals, 2)} USDC` };
          setProgress([...status]);
          void logSwapHash(hash);
          if (i < review.legs.length - 1) {
            setBusy(`pause-${i + 1}`);
            await new Promise((r) => setTimeout(r, LEG_PAUSE_MS));
          }
        } catch (e) {
          status[i] = { ...status[i], status: 'stopped' };
          setProgress([...status]);
          setRest(legsLeft());
          setReview(null);
          void refetchBalance();
          throw e;
        }
      }
      setReview(null);
      setApprovedFor(null);
      void refetchBalance();
      notify({ kind: 'tx', tone: 'success', title: 'Basket bought', body: status.map((s) => s.text).join(' · ') });
    });

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet on Base to buy this basket.</p>
        <WalletConnectButton />
      </>
    );
  }

  const legCount = review?.legs.length ?? 0;
  const label = (() => {
    if (!busy) return null;
    if (busy === 'review') return 'Preparing…';
    if (busy === 'approve') return 'Approve USDC in wallet…';
    const [kind, idx] = busy.split('-');
    const sym = review?.legs[Number(idx)]?.plan.symbol ?? '';
    if (kind === 'pause') return `Getting ${sym} ready…`;
    return kind === 'leg' ? `Confirm ${sym} in wallet (${Number(idx) + 1} of ${legCount})…` : `Confirming ${sym} onchain…`;
  })();
  const bought = progress?.filter((p) => p.status === 'done') ?? [];
  const reviewTotal = review?.legs.reduce((s, l) => s + l.plan.amountIn, BigInt(0)) ?? BigInt(0);
  const feeBps = review?.legs[0]?.tx.quote.feeBps ?? 0;

  return (
    <div className="swap-panel">
      <p className="geo-note" style={{ marginTop: 0 }}>
        Your wallet: {balance !== undefined ? `${fmt(balance, USDC.decimals)} USDC` : '…'} on Base
      </p>
      <div className="basket-row">
        <input
          inputMode="decimal"
          aria-label="USDC to spend on the basket"
          placeholder="USDC amount"
          className="basket-amount"
          value={amount}
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9.]/g, '');
            if (/^\d*\.?\d{0,6}$/.test(next)) {
              setAmount(next);
              setReview(null);
            }
          }}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-secondary" onClick={() => balance !== undefined && setAmount(formatUnits(balance, USDC.decimals))} disabled={busy !== null || !balance}>
          Max
        </button>
        {!review && (
          <button type="button" className="btn" onClick={() => plan && startReview(plan)} disabled={busy !== null || !plan || !!problem || overBalance}>
            {label ?? 'Review'}
          </button>
        )}
      </div>
      {overBalance && <p className="geo-note">That is more USDC than your wallet holds on Base.</p>}
      {problem && <p className="geo-note">{problem}</p>}
      {plan && !problem && !review && (
        <p className="geo-note">Splits into {plan.map((l) => `${l.symbol} ${usd(Number(l.amountIn) / 1e6)}`).join(' · ')}, one swap each.</p>
      )}

      {review && (
        <div className="swap-review">
          <dl>
            {review.legs.map(({ plan: leg, tx }) => (
              <div key={leg.symbol} style={{ display: 'contents' }}>
                <dt>{leg.symbol}</dt>
                <dd>
                  {fmt(leg.amountIn, USDC.decimals, 2)} USDC → about {fmt(tx.quote.amountOut, decimalsOf(leg.symbol), decimalsOf(leg.symbol))} {leg.symbol}, at least{' '}
                  {fmt(legFloor(BigInt(tx.minAmountOut)), decimalsOf(leg.symbol), decimalsOf(leg.symbol))} · {venueNames(tx.quote.venues)}
                </dd>
              </div>
            ))}
            <dt>You pay</dt>
            <dd>
              {fmt(reviewTotal, USDC.decimals, 2)} USDC in {legCount} swaps
            </dd>
            <dt>Afterbook fee</dt>
            <dd>{feeBps > 0 ? `${(feeBps / 100).toFixed(2)}% of each swap` : 'none'}</dd>
            <dt>Contract</dt>
            <dd>
              <a href={`https://basescan.org/address/${KYBER_ROUTER}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                KyberSwap router {KYBER_ROUTER.slice(0, 6)}…{KYBER_ROUTER.slice(-4)}&nbsp;<span className="ext-arrow">↗</span>
              </a>
            </dd>
          </dl>
          <p className="geo-note">
            Your wallet asks to approve exactly {fmt(reviewTotal, USDC.decimals, 2)} USDC for this router (skipped if it already can), then for {legCount} swaps,
            one per stock. Each is rebuilt just before you sign it and is only sent if you still get at least the amount above. If one stops, you keep what
            was already bought and can buy the rest. You need a little ETH on Base for network fees.
          </p>
          <div className="basket-row">
            <button type="button" className="btn" onClick={confirm} disabled={busy !== null}>
              {label ?? `Buy ${legCount} stocks`}
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
                  bought {p.text}{' '}
                  <a href={`https://basescan.org/tx/${p.hash as Hex}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                    View&nbsp;<span className="ext-arrow">↗</span>
                  </a>
                </>
              ) : p.status === 'sending' ? (
                'in progress'
              ) : (
                'not bought'
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
      {approvedFor && !rest && !review && !busy && (
        <p className="geo-note">
          The router may still be approved to spend {fmt(approvedFor.reduce((s, l) => s + l.amountIn, BigInt(0)), USDC.decimals, 2)} USDC from your wallet.
          Reviewing this basket again uses it, or you can set the approval back to zero in your wallet.
        </p>
      )}
      {rest && rest.length > 0 && !review && (
        <>
          <p className="geo-note">
            {bought.length > 0 ? `You hold what was bought above. ` : ''}Not bought: {rest.map((l) => `${l.symbol} (${fmt(l.amountIn, USDC.decimals, 2)} USDC)`).join(', ')}. The
            router may still be approved to spend that USDC from your wallet; buying the rest uses it, or you can set the approval back to zero in your
            wallet.
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
