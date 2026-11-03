'use client';

import { useEffect, useState } from 'react';
import { formatUnits, type Hex } from 'viem';
import { SLIPPAGE_BPS, type SwapQuote, type SwapSide } from '@/lib/swap';
import { USDC, type CbStock } from '@/lib/tokens';
import { WalletConnectButton } from './WalletConnectButton';
import { fmt, logSwapHash, usd, venueNames } from './swapClient';
import { useNotify } from './notify';
import { buildSwap, parseAmount, useLiveQuote, useReviewedSwap, useTokenBalance } from './useSwapWallet';

// Buy or sell a tracked stock token with USDC from the visitor's own wallet, routed by KyberSwap.
// The server (lib/swap.ts) builds the transaction and refuses it unless every field matches the
// request; this panel shows the checked numbers and hands the wallet steps (exact-amount approval of
// the router if needed, the swap with Afterbook's Builder Code) to useSwapWallet.ts. It never holds
// funds or signs.

export function SwapPanel({ stock, defaultUsd }: { stock: CbStock; defaultUsd?: number }) {
  const { notify } = useNotify();
  const [side, setSide] = useState<SwapSide>('buy');
  const [amount, setAmount] = useState(defaultUsd ? String(Math.round(defaultUsd)) : '');

  const inToken = side === 'buy' ? { address: USDC.address, decimals: USDC.decimals, symbol: 'USDC' } : { address: stock.tokenAddress, decimals: stock.decimals, symbol: stock.symbol };
  const outToken = side === 'buy' ? { decimals: stock.decimals, symbol: stock.symbol } : { decimals: USDC.decimals, symbol: 'USDC' };
  const { balance, refetchBalance } = useTokenBalance(inToken.address);

  // Amount in raw units of the token being sold, or null while the field is empty / not a number.
  const amountIn = parseAmount(amount, inToken.decimals);
  const overBalance = amountIn !== null && balance !== undefined && amountIn > balance;
  const amountKey = amountIn?.toString() ?? '';
  const { quote, quoteError, clearQuote } = useLiveQuote(amountKey ? `/api/swap/quote?symbol=${stock.symbol}&side=${side}&amountIn=${amountKey}` : null);

  const { address, busy, error, review, setReview, done, setDone, startReview, confirm, reset } = useReviewedSwap({
    build: async () => buildSwap({ symbol: stock.symbol, side, amountIn: amountKey, account: address }),
    sameTrade: (tx, reviewed) => tx.quote.amountIn === reviewed.quote.amountIn && tx.quote.symbol === reviewed.quote.symbol && tx.quote.side === reviewed.quote.side && tx.tokenIn === reviewed.tokenIn,
    texts: {
      declined: 'Declined in your wallet — nothing was submitted.',
      declinedTitle: 'Swap declined',
      declinedBody: 'Nothing was submitted.',
      failedTitle: 'Swap failed',
      approvalReverted: `The ${inToken.symbol} approval reverted onchain. Nothing was swapped.`,
      reverted: 'The swap reverted onchain (price moved past the 0.5% limit). Your funds did not move.',
    },
    onSwapped: (tx, hash) => {
      const text = side === 'buy'
        ? `Bought ${stock.symbol} with ${fmt(tx.quote.amountIn, USDC.decimals, 2)} USDC.`
        : `Sold ${fmt(tx.quote.amountIn, stock.decimals)} ${stock.symbol} for USDC.`;
      setDone({ hash, text });
      setAmount('');
      notify({ kind: 'tx', tone: 'success', title: side === 'buy' ? `Bought ${stock.symbol}` : `Sold ${stock.symbol}`, body: text });
      void refetchBalance();
      void logSwapHash(hash);
    },
  });

  // Reset when the stock or direction changes; a review is only valid for what it was built for.
  useEffect(() => {
    reset();
    clearQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock.symbol, side]);
  // A new amount voids the card.
  useEffect(() => setReview(null), [amountKey, setReview]);

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
      <div className="carry-direction-toggle swap-side-toggle" role="tablist" aria-label="Buy or sell">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={side === s ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => {
              if (s === side) return;
              // The amount is in the token being sold, so it means something else on the other side
              // (0.33 USDC became 0.33 NVDAc, ~$72): start the other side empty.
              setSide(s);
              setAmount('');
            }}
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
                KyberSwap router {review.to.slice(0, 6)}…{review.to.slice(-4)}&nbsp;<span className="ext-arrow">↗</span>
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

      {quoteError && !review && (
        // A size limit (the $25k cap, or a buy over 10% of a thin pool) is an answer, not an outage.
        /limited to/.test(quoteError) ? (
          <p className="geo-note geo-note-blocked">{quoteError}. Lower the amount.</p>
        ) : (
          <p className="geo-note">Price check failed: {quoteError}. Retrying every 15 s.</p>
        )
      )}
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
