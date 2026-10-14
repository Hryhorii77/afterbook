'use client';

import { useEffect, useState } from 'react';
import { useAccount, usePublicClient, useReadContract, useSendTransaction, useSwitchChain, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { concat, erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/builderCode';
import { KYBER_ROUTER, SLIPPAGE_BPS, type SwapQuote, type SwapSide, type SwapTx } from '@/lib/swap';
import { USDC, type CbStock } from '@/lib/tokens';
import { WalletConnectButton } from './WalletConnectButton';
import { useNotify } from './notify';

// Buy or sell a tracked stock token with USDC from the visitor's own wallet, routed by KyberSwap.
// The server (lib/swap.ts) builds the transaction and refuses it unless every field matches the
// request; this panel shows the checked numbers, asks for an exact-amount approval of the router if
// needed, and sends the transaction with Afterbook's Builder Code. It never holds funds or signs.

async function api<T>(path: string, init?: { body: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init ? 'POST' : 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

// Reports a confirmed swap for the metrics; retried because the server's RPC can lag the wallet's.
async function logSwapHash(hash: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api('/api/swap/log', { body: { hash } });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// KyberSwap's venue ids ("aerodrome-cl-3", "sectorone-v20") as names a trader recognises.
const venueNames = (venues: string[]) => {
  const named = new Set(venues.map((v) => (/aerodrome/i.test(v) ? 'Aerodrome' : /uniswap/i.test(v) ? 'Uniswap' : 'other Base pools')));
  return [...named].sort((a, b) => (a === 'other Base pools' ? 1 : b === 'other Base pools' ? -1 : a.localeCompare(b))).join(' and ');
};

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt = (raw: string | bigint, decimals: number, max = 4) =>
  Number(formatUnits(BigInt(raw), decimals)).toLocaleString('en-US', { maximumFractionDigits: max });

export function SwapPanel({ stock, defaultUsd }: { stock: CbStock; defaultUsd?: number }) {
  const { address, chainId } = useAccount();
  const { notify } = useNotify();
  const publicClient = usePublicClient({ chainId: base.id });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  const [side, setSide] = useState<SwapSide>('buy');
  const [amount, setAmount] = useState(defaultUsd ? String(Math.round(defaultUsd)) : '');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [review, setReview] = useState<SwapTx | null>(null);
  const [reviewedAt, setReviewedAt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed background price refresh is its own message, hidden while a review is open (the review
  // holds checked numbers of its own), so it never reads like the swap failed.
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);

  const inToken = side === 'buy' ? { address: USDC.address, decimals: USDC.decimals, symbol: 'USDC' } : { address: stock.tokenAddress, decimals: stock.decimals, symbol: stock.symbol };
  const outToken = side === 'buy' ? { decimals: stock.decimals, symbol: stock.symbol } : { decimals: USDC.decimals, symbol: 'USDC' };

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

  // Amount in raw units of the token being sold, or null while the field is empty / not a number.
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

  // Reset when the stock or direction changes; a review is only valid for what it was built for.
  useEffect(() => {
    setReview(null);
    setQuote(null);
    setError(null);
    setQuoteError(null);
    setDone(null);
  }, [stock.symbol, side]);

  // Live preview: debounced on typing, refreshed every 15 s while nothing is in flight.
  const amountKey = amountIn?.toString() ?? '';
  useEffect(() => {
    setReview(null);
    if (!amountKey) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const load = () =>
      api<SwapQuote>(`/api/swap/quote?symbol=${stock.symbol}&side=${side}&amountIn=${amountKey}`)
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
  }, [amountKey, side, stock.symbol]);

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
          ? { kind: 'tx', tone: 'info', title: 'Swap declined', body: 'Nothing was submitted.' }
          : { kind: 'tx', tone: 'error', title: 'Swap failed', body: msg },
      );
    } finally {
      setBusy(null);
    }
  };

  const build = async (): Promise<SwapTx> => {
    const tx = await api<SwapTx>('/api/swap/build', { body: { symbol: stock.symbol, side, amountIn: amountKey, account: address } });
    // The server already checked the calldata; this guards the one thing the wallet is pointed at.
    if (getAddress(tx.to) !== KYBER_ROUTER || getAddress(tx.spender) !== KYBER_ROUTER) throw new Error('Refused: unexpected contract.');
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

      // Everything below uses the reviewed values, never the live input field.
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
        // Prices moved while the approval confirmed or the card sat open: rebuild. The wallet is only
        // asked to sign it without a second look if it is the same trade with a minimum at least as
        // good as the one on the card; otherwise the card shows the new numbers and asks again.
        setBusy('rebuild');
        tx = await build();
        const same = tx.quote.amountIn === review.quote.amountIn && tx.quote.symbol === review.quote.symbol && tx.quote.side === review.quote.side && tx.tokenIn === review.tokenIn;
        if (!same || BigInt(tx.minAmountOut) < BigInt(review.minAmountOut)) {
          setReview(tx);
          setReviewedAt(Date.now());
          throw new Error('The price moved since you reviewed it. Check the new numbers and confirm again (no approval needed this time).');
        }
      }

      setBusy('swap');
      const hash = await sendTransactionAsync({
        to: tx.to,
        data: concat([tx.data, BUILDER_CODE_SUFFIX]),
        value: BigInt(0),
        chainId: base.id,
      });
      setReview(null);
      setBusy('confirming');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The swap reverted onchain (price moved past the 0.5% limit). Your funds did not move.');
      const text = side === 'buy'
        ? `Bought ${stock.symbol} with ${fmt(tx.quote.amountIn, USDC.decimals, 2)} USDC.`
        : `Sold ${fmt(tx.quote.amountIn, stock.decimals)} ${stock.symbol} for USDC.`;
      setDone({ hash, text });
      setAmount('');
      notify({ kind: 'tx', tone: 'success', title: side === 'buy' ? `Bought ${stock.symbol}` : `Sold ${stock.symbol}`, body: text });
      void refetchBalance();
      void logSwapHash(hash);
    });

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet on Base to buy or sell {stock.symbol} here.</p>
        <WalletConnectButton />
      </>
    );
  }

  const feeNote = (q: SwapQuote) => (q.feeBps > 0 ? `${(q.feeBps / 100).toFixed(2)}% (${usd((q.amountInUsd * q.feeBps) / 10_000)})` : 'none');
  const busyLabel: Record<string, string> = {
    review: 'Preparing…',
    approve: `Approve ${inToken.symbol} in wallet…`,
    rebuild: 'Refreshing price…',
    swap: 'Confirm in wallet…',
    confirming: 'Confirming onchain…',
  };

  return (
    <div className="swap-panel">
      <div className="carry-direction-toggle" role="tablist" aria-label="Buy or sell">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={side === s ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => setSide(s)}
            disabled={busy !== null}
          >
            {s === 'buy' ? `Buy ${stock.symbol}` : `Sell ${stock.symbol}`}
          </button>
        ))}
      </div>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Your wallet: {balance !== undefined ? `${fmt(balance, inToken.decimals)} ${inToken.symbol}` : '…'} on Base
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
            // Refuse more decimals than the token has rather than silently rounding the amount sold.
            if (new RegExp(`^\\d*\\.?\\d{0,${inToken.decimals}}$`).test(next)) setAmount(next);
          }}
          disabled={busy !== null}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => balance !== undefined && setAmount(formatUnits(balance, inToken.decimals))}
          disabled={busy !== null || !balance}
        >
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
          About {fmt(quote.amountOut, outToken.decimals)} {outToken.symbol} ({usd(quote.amountOutUsd)}) · Afterbook fee {feeNote(quote)} · network
          fee ~{usd(quote.gasUsd)}
        </p>
      )}

      {review && (
        <div className="swap-review">
          <dl>
            <dt>You pay</dt>
            <dd>{fmt(review.quote.amountIn, inToken.decimals)} {inToken.symbol} ({usd(review.quote.amountInUsd)})</dd>
            <dt>You get (estimate)</dt>
            <dd>{fmt(review.quote.amountOut, outToken.decimals, outToken.decimals)} {outToken.symbol}</dd>
            <dt>Minimum you get</dt>
            <dd>{fmt(review.minAmountOut, outToken.decimals, outToken.decimals)} {outToken.symbol} · reverts below this ({SLIPPAGE_BPS / 100}% limit)</dd>
            <dt>Afterbook fee</dt>
            <dd>{feeNote(review.quote)}</dd>
            <dt>Route</dt>
            <dd>{venueNames(review.quote.venues)} via KyberSwap</dd>
            <dt>Contract</dt>
            <dd>
              <a href={`https://basescan.org/address/${review.to}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                KyberSwap router {review.to.slice(0, 6)}…{review.to.slice(-4)} ↗
              </a>
            </dd>
          </dl>
          <p className="geo-note">
            Your wallet may first ask to approve exactly {fmt(review.quote.amountIn, inToken.decimals)} {inToken.symbol} for this router, then the swap. If the
            price moves while that approval confirms, you see the new numbers before anything else is signed. You need a little ETH on Base for network fees.
          </p>
          <div className="basket-row">
            <button type="button" className="btn" onClick={confirm} disabled={busy !== null}>
              {busy ? busyLabel[busy] : side === 'buy' ? `Buy ${stock.symbol}` : `Sell ${stock.symbol}`}
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
            View transaction ↗
          </a>
        </p>
      )}
    </div>
  );
}
