'use client';

import { useEffect, useState } from 'react';
import { formatUnits, getAddress, type Hex } from 'viem';
import { MAX_MEME_SWAP_USD, type SwapQuote } from '@/lib/swap/swap';
import { USDC, type CbStock } from '@/lib/stocks/tokens';
import { WalletConnectButton } from '../layout/WalletConnectButton';
import { fmt, logSwapHash, usd, venueNames } from '../swap/swapClient';
import { useNotify } from '../notifications/notify';
import { buildSwap, parseAmount, useLiveQuote, useReviewedSwap, useTokenBalance } from '../swap/useSwapWallet';
import { SlippageControl, useSlippage } from '../swap/slippage';

// Buy an allowlisted meme with USDC or the stock token its pool is priced in, from the visitor's own
// wallet, routed by KyberSwap. Same rules as SwapPanel: the server (lib/swap/memeSwap.ts + lib/swap/swap.ts)
// builds the transaction and refuses it unless every field matches; this panel shows the checked
// numbers and useSwapWallet.ts approves exactly the reviewed amount for the router only and sends
// with the Builder Code. Buy only: selling a meme is left to the venue.

type PayWith = 'USDC' | 'stock';

export function MemeBuyPanel({ meme, stock }: { meme: { address: `0x${string}`; symbol: string; decimals: number }; stock: CbStock }) {
  const { notify } = useNotify();
  const [payWith, setPayWith] = useState<PayWith>('USDC');
  const [amount, setAmount] = useState('');
  const slippageBps = useSlippage();

  const inToken =
    payWith === 'USDC'
      ? { address: USDC.address as `0x${string}`, decimals: USDC.decimals, symbol: 'USDC', param: 'USDC' }
      : { address: stock.tokenAddress, decimals: stock.decimals, symbol: stock.symbol, param: stock.symbol };
  const { balance, refetchBalance } = useTokenBalance(inToken.address);

  const amountIn = parseAmount(amount, inToken.decimals);
  const overBalance = amountIn !== null && balance !== undefined && amountIn > balance;
  const amountKey = amountIn?.toString() ?? '';
  const { quote, quoteError, clearQuote } = useLiveQuote(amountKey ? `/api/swap/quote?meme=${meme.address}&payWith=${inToken.param}&amountIn=${amountKey}` : null);

  const { address, busy, error, review, setReview, done, setDone, startReview, confirm, reset } = useReviewedSwap({
    build: async () => {
      const tx = await buildSwap({ meme: meme.address, payWith: inToken.param, amountIn: amountKey, account: address, slippageBps });
      // The server already checked the calldata; this also checks that it is this buy.
      if (!tx.quote.meme || getAddress(tx.quote.meme) !== getAddress(meme.address) || getAddress(tx.tokenIn) !== getAddress(inToken.address) || tx.quote.side !== 'buy') {
        throw new Error('Refused: the transaction is not this buy.');
      }
      return tx;
    },
    sameTrade: (tx, reviewed) => tx.quote.amountIn === reviewed.quote.amountIn && tx.quote.meme === reviewed.quote.meme && tx.tokenIn === reviewed.tokenIn,
    texts: {
      declined: 'Declined in your wallet — nothing was submitted.',
      declinedTitle: 'Buy declined',
      declinedBody: 'Nothing was submitted.',
      failedTitle: 'Buy failed',
      approvalReverted: `The ${inToken.symbol} approval reverted onchain. Nothing was bought.`,
      reverted: `The buy reverted onchain (price moved past the ${slippageBps / 100}% limit). Your funds did not move.`,
    },
    onSwapped: (tx, hash) => {
      const text = `Bought ${meme.symbol} with ${fmt(tx.quote.amountIn, inToken.decimals)} ${inToken.symbol}.`;
      setDone({ hash, text });
      setAmount('');
      notify({ kind: 'tx', tone: 'success', title: `Bought ${meme.symbol}`, body: text });
      void refetchBalance();
      void logSwapHash(hash);
    },
  });

  useEffect(() => {
    reset();
    clearQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meme.address, payWith]);
  useEffect(() => setReview(null), [amountKey, payWith, slippageBps, setReview]);

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
      {!review && <SlippageControl disabled={busy !== null} />}

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
              {fmt(review.minAmountOut, meme.decimals, 2)} {meme.symbol} · reverts below this ({slippageBps / 100}% limit)
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
