'use client';

import { useEffect, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { concat, erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/builderCode';
import { KYBER_ROUTER, MAX_MEME_SWAP_USD, SLIPPAGE_BPS, type SwapQuote, type SwapTx } from '@/lib/swap';
import { USDC, type CbStock } from '@/lib/tokens';
import { WalletConnectButton } from './WalletConnectButton';
import { api, fmt, logSwapHash, usd, venueNames } from './swapClient';
import { useNotify } from './notify';

// Buy an allowlisted meme with USDC or the stock token its pool is priced in, from the visitor's own
// wallet, routed by KyberSwap. Same rules as SwapPanel: the server (lib/memeSwap.ts + lib/swap.ts)
// builds the transaction and refuses it unless every field matches; this panel shows the checked
// numbers, approves exactly the reviewed amount for the router only, and sends with the Builder Code.
// Buy only: selling a meme is left to the venue.

type PayWith = 'USDC' | 'stock';

export function MemeBuyPanel({ meme, stock }: { meme: { address: `0x${string}`; symbol: string; decimals: number }; stock: CbStock }) {
  const { address, chainId } = useAccount();
  const { notify } = useNotify();
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [payWith, setPayWith] = useState<PayWith>('USDC');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [review, setReview] = useState<SwapTx | null>(null);
  const [reviewedAt, setReviewedAt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);

  const inToken =
    payWith === 'USDC'
      ? { address: USDC.address as `0x${string}`, decimals: USDC.decimals, symbol: 'USDC', param: 'USDC' }
      : { address: stock.tokenAddress, decimals: stock.decimals, symbol: stock.symbol, param: stock.symbol };

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: inToken.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: !!address },
  });
  const { refetch: refetchAllowance } = useReadContract({
    address: inToken.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address ? [address, KYBER_ROUTER] : undefined,
    chainId: base.id,
    query: { enabled: !!address },
  });

  const amountIn = (() => {
    if (!/^\d*\.?\d+$/.test(amount)) return null;
    try {
      const v = parseUnits(amount, inToken.decimals);
      return v > BigInt(0) ? v : null;
    } catch {
      return null;
    }
  })();
  const overBalance = amountIn !== null && balance !== undefined && amountIn > balance;

  useEffect(() => {
    setReview(null);
    setQuote(null);
    setError(null);
    setQuoteError(null);
    setDone(null);
  }, [meme.address, payWith]);

  const amountKey = amountIn?.toString() ?? '';
  const quotePath = `/api/swap/quote?meme=${meme.address}&payWith=${inToken.param}&amountIn=${amountKey}`;
  useEffect(() => {
    setReview(null);
    if (!amountKey) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api<SwapQuote>(quotePath)
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
  }, [amountKey, quotePath]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? 'failed';
      const declined = /reject|denied/i.test(msg);
      setError(declined ? 'Declined in your wallet — nothing was submitted.' : msg);
      notify(
        declined
          ? { kind: 'tx', tone: 'info', title: 'Buy declined', body: 'Nothing was submitted.' }
          : { kind: 'tx', tone: 'error', title: 'Buy failed', body: msg },
      );
    } finally {
      setBusy(null);
    }
  };

  const build = async (): Promise<SwapTx> => {
    const tx = await api<SwapTx>('/api/swap/build', { body: { meme: meme.address, payWith: inToken.param, amountIn: amountKey, account: address } });
    // The server already checked the calldata; this guards what the wallet is pointed at and that it is this buy.
    if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
    if (!tx.quote.meme || getAddress(tx.quote.meme) !== getAddress(meme.address) || getAddress(tx.tokenIn) !== getAddress(inToken.address) || tx.quote.side !== 'buy') {
      throw new Error('Refused: the transaction is not this buy.');
    }
    return tx;
  };

  const startReview = () =>
    run('review', async () => {
      setDone(null);
      setReview(await build());
      setReviewedAt(Date.now());
    });

  const confirm = () =>
    run('swap', async () => {
      if (!address || !review || !publicClient) return;
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });

      const reviewedIn = BigInt(review.quote.amountIn);
      let tx = review;
      let stale = Date.now() - reviewedAt > 60_000;
      const { data: allowance } = await refetchAllowance();
      if ((allowance ?? BigInt(0)) < reviewedIn) {
        // Exactly the reviewed amount, never unlimited, and only ever for the router.
        setBusy('approve');
        const approval = await writeContractAsync({
          address: review.tokenIn,
          abi: erc20Abi,
          functionName: 'approve',
          args: [KYBER_ROUTER, reviewedIn],
          chainId: base.id,
          dataSuffix: BUILDER_CODE_SUFFIX,
        });
        await publicClient.waitForTransactionReceipt({ hash: approval });
        stale = true;
      }
      if (stale) {
        setBusy('rebuild');
        tx = await build();
        const same = tx.quote.amountIn === review.quote.amountIn && tx.quote.meme === review.quote.meme && tx.tokenIn === review.tokenIn;
        if (!same || BigInt(tx.minAmountOut) < BigInt(review.minAmountOut)) {
          setReview(tx);
          setReviewedAt(Date.now());
          throw new Error('The price moved since you reviewed it. Check the new numbers and confirm again (no approval needed this time).');
        }
      }

      setBusy('swap');
      const hash = await sendTransactionAsync({ to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]), value: BigInt(0), chainId: base.id });
      setReview(null);
      setBusy('confirming');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The buy reverted onchain (price moved past the 0.5% limit). Your funds did not move.');
      const text = `Bought ${meme.symbol} with ${fmt(tx.quote.amountIn, inToken.decimals)} ${inToken.symbol}.`;
      setDone({ hash, text });
      setAmount('');
      notify({ kind: 'tx', tone: 'success', title: `Bought ${meme.symbol}`, body: text });
      void refetchBalance();
      void logSwapHash(hash);
    });

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet on Base to buy {meme.symbol} here.</p>
        <WalletConnectButton />
      </>
    );
  }

  // Value lost to the trade itself (price impact and pool fees), when both sides have a USD price.
  const impact = (q: SwapQuote) => (q.amountInUsd > 0 && q.amountOutUsd > 0 ? 1 - q.amountOutUsd / q.amountInUsd : null);
  const impactNote = (q: SwapQuote) => {
    const i = impact(q);
    return i == null ? 'price impact unknown' : `about ${(Math.max(0, i) * 100).toFixed(1)}% lost to price impact and pool fees`;
  };
  const busyLabel: Record<string, string> = {
    review: 'Preparing…',
    approve: `Approve ${inToken.symbol} in wallet…`,
    rebuild: 'Refreshing price…',
    swap: 'Confirm in wallet…',
    confirming: 'Confirming onchain…',
  };

  return (
    <div className="swap-panel">
      <div className="carry-direction-toggle swap-side-toggle" role="tablist" aria-label="Pay with">
        {(['USDC', 'stock'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={payWith === p}
            className={payWith === p ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => {
              if (p === payWith) return;
              setPayWith(p);
              setAmount('');
            }}
            disabled={busy !== null}
          >
            Pay with {p === 'USDC' ? 'USDC' : stock.symbol}
          </button>
        ))}
      </div>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Your wallet: {balance !== undefined ? `${fmt(balance, inToken.decimals)} ${inToken.symbol}` : '…'} on Base · up to {usd(MAX_MEME_SWAP_USD)} per buy
      </p>
      <div className="basket-row">
        <input
          inputMode="decimal"
          aria-label={`${inToken.symbol} amount`}
          placeholder={`${inToken.symbol} amount`}
          className="basket-amount"
          value={amount}
          onChange={(e) => {
            const next = e.target.value.replace(/[^0-9.]/g, '');
            if (new RegExp(`^\\d*\\.?\\d{0,${inToken.decimals}}$`).test(next)) setAmount(next);
          }}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-secondary" onClick={() => balance !== undefined && setAmount(formatUnits(balance, inToken.decimals))} disabled={busy !== null || !balance}>
          Max
        </button>
        {!review && (
          <button type="button" className="btn" onClick={startReview} disabled={busy !== null || !amountIn || overBalance || !quote}>
            {busy ? busyLabel[busy] : 'Review'}
          </button>
        )}
      </div>
      {overBalance && <p className="geo-note">That is more {inToken.symbol} than your wallet holds on Base.</p>}

      {quote && !review && (
        <p className="geo-note">
          About {fmt(quote.amountOut, meme.decimals, 2)} {meme.symbol} · {impactNote(quote)} · no Afterbook fee · network fee ~{usd(quote.gasUsd)}
        </p>
      )}
      {quote && !review && (impact(quote) ?? 0) > 0.05 && (
        <p className="geo-note geo-note-blocked">This pool is thin for this size: over 5% of the value is lost on the way in. A smaller amount loses less.</p>
      )}

      {review && (
        <div className="swap-review">
          <dl>
            <dt>You pay</dt>
            <dd>
              {fmt(review.quote.amountIn, inToken.decimals)} {inToken.symbol} ({usd(review.quote.amountInUsd)})
            </dd>
            <dt>You get (estimate)</dt>
            <dd>
              {fmt(review.quote.amountOut, meme.decimals, 2)} {meme.symbol}
            </dd>
            <dt>Minimum you get</dt>
            <dd>
              {fmt(review.minAmountOut, meme.decimals, 2)} {meme.symbol} · reverts below this ({SLIPPAGE_BPS / 100}% limit)
            </dd>
            <dt>Cost of the trade</dt>
            <dd>{impactNote(review.quote)} · no Afterbook fee</dd>
            <dt>Token</dt>
            <dd>
              <a href={`https://basescan.org/token/${meme.address}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                {meme.symbol} {meme.address.slice(0, 6)}…{meme.address.slice(-4)}&nbsp;<span className="ext-arrow">↗</span>
              </a>
            </dd>
            <dt>Route</dt>
            <dd>{venueNames(review.quote.venues)} via KyberSwap</dd>
            <dt>Contract</dt>
            <dd>
              <a href={`https://basescan.org/address/${review.to}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                KyberSwap router {review.to.slice(0, 6)}…{review.to.slice(-4)}&nbsp;<span className="ext-arrow">↗</span>
              </a>
            </dd>
          </dl>
          <p className="meme-warning" style={{ margin: '12px 0' }}>
            <strong>Any memecoin can go to zero.</strong> You may not be able to sell {meme.symbol} later for anything like what you paid. Only
            buy what you can lose.
          </p>
          <p className="geo-note">
            Your wallet may first ask to approve exactly {fmt(review.quote.amountIn, inToken.decimals)} {inToken.symbol} for this router, then the buy. You need a
            little ETH on Base for network fees.
          </p>
          <div className="basket-row">
            <button type="button" className="btn" onClick={confirm} disabled={busy !== null}>
              {busy ? busyLabel[busy] : `Buy ${meme.symbol}`}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setReview(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {quoteError && !review && <p className="geo-note">Price check failed: {quoteError}. Retrying every 15 s.</p>}
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
      {done && (
        <p className="geo-note">
          {done.text}{' '}
          <a href={`https://basescan.org/tx/${done.hash as Hex}`} target="_blank" rel="noopener noreferrer" className="emph-link">
            View transaction&nbsp;<span className="ext-arrow">↗</span>
          </a>
        </p>
      )}
    </div>
  );
}
