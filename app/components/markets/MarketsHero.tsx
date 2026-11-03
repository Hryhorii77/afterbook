'use client';

// The top of the Markets page: the active stock's gap as one plain sentence, its cash and onchain
// prices, Share and the words explained; plus the compact bar that pins the gap once the hero has
// scrolled away.
import { useEffect, useRef, useState } from 'react';
import { poolVenue, type CbStock } from '@/lib/tokens';
import type { TapeResult, TapeRow } from '@/lib/tape';
import { bp, bpPct, usd, usdCompact, formatNextOpen, gapSizeText } from '@/lib/format';
import { heroGapBp, heroReferenceLabel, shortName, stockShareText } from '@/lib/shareText';
import { SymbolTile } from '../SymbolTile';
import { ShareButton } from '../ShareButton';
import { SessionPill } from '../SessionPill';
import { SymbolOptions } from './SymbolOptions';

interface Props {
  tape: TapeResult;
  symbol: string;
  activeRow: TapeRow | undefined;
  activeStock: CbStock;
  liquidRows: TapeRow[];
  thinRows: TapeRow[];
  setSymbolAndUrl: (sym: string) => void;
}

export function MarketsHero({ tape, symbol, activeRow, activeStock, liquidRows, thinRows, setSymbolAndUrl }: Props) {
  // The compact pinned bar only shows once the hero card has scrolled out of
  // view (under the site header), so the number is never repeated on screen.
  const heroRef = useRef<HTMLElement>(null);
  const [heroGone, setHeroGone] = useState(false);
  const hasHero = !!activeRow;
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setHeroGone(!entry.isIntersecting && entry.boundingClientRect.bottom < 120),
      { rootMargin: '-56px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasHero]);

  const extendedName = tape.session.state === 'pre-market' ? 'pre-market' : 'after-hours';
  // While the cash market is shut the headline gap is anchored to the actual close (same
  // basis /today uses), not a live extended-hours print, so the sentence below, the big
  // number and /today never disagree about the same instant.
  const heroBp = heroGapBp(activeRow, tape.session);
  // Before the open and after the close the row only holds an extended-hours price when Yahoo
  // had a real print (cashPriceType). Without one, "cash" is still the last regular close, so
  // the label must say so instead of claiming a pre-market / after-hours price.
  const onExtendedPrint = activeRow?.cashPriceType === 'pre-market' || activeRow?.cashPriceType === 'after-hours';
  const usingClose = tape.session.state.startsWith('closed') || (tape.session.state !== 'open' && !onExtendedPrint);
  const referenceLabel = heroReferenceLabel(activeRow, tape);
  const heroCashLabel = tape.session.state === 'open' ? 'Cash price' : usingClose ? 'Cash close' : `Cash ${extendedName}`;

  const scrollToLotLab = () => {
    document.getElementById('lot-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <>
    {activeRow && (
      <section className="panel today-hero tape-hero" ref={heroRef}>
        <div className="today-top">
          <div className="today-id">
            <SymbolTile cashTicker={activeRow.cashTicker} />
            <div className="sym-cell-text">
              <select className="hero-symbol-select" value={symbol} onChange={(e) => setSymbolAndUrl(e.target.value)} aria-label="Active symbol">
                <SymbolOptions liquidRows={liquidRows} thinRows={thinRows} />
              </select>
              <span className="symbol-name" title={activeRow.name}>{activeRow.name}</span>
            </div>
          </div>
          <SessionPill state={tape.session.state} label={tape.session.label} nyTime={tape.session.nyTime} />
        </div>

        <div className="today-stats">
          <div className="stat-card stat-card-hero">
            <div className="stat-label" style={{ marginTop: 0 }}>Onchain price vs cash price</div>
            {/* The percent is the headline (everyone reads %); bp, the trader's unit, sits beside it. */}
            <div className={`today-stat-value ${heroBp != null ? (heroBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}`}>
              {bpPct(heroBp)}
              {heroBp != null && <span className="today-stat-bp">{bp(heroBp)}</span>}
            </div>
            {heroBp != null && (
              <div className="hero-sentence">
                {/* One string per sentence: separate text pieces read as "4.1 bpbelowthe" to some
                    accessibility tools, which drop the lone spaces between them. */}
                {`On ${poolVenue(activeStock)}, ${shortName(activeRow)} is trading ${gapSizeText(heroBp)} ${heroBp >= 0 ? 'above' : 'below'} `}
                <span className="nowrap">{referenceLabel}</span>
                {'.'}
                {tape.session.state.startsWith('closed') && ` Cash reopens ${formatNextOpen(tape.session.nextOpenIso)}.`}
              </div>
            )}
          </div>
          <div className="stat-card">
            <div className="stat-value">{usd(activeRow.cashLastUsd)}</div>
            <div className="stat-label">{heroCashLabel}</div>
          </div>
          {/* The price you can actually trade at, so it carries more weight than the reference
              cash price beside it; its pool's liquidity says how much it can take. */}
          <div className="stat-card stat-card-onchain">
            <div className="stat-value">{usd(activeRow.onchainMidUsd)}</div>
            <div className="stat-label">Onchain price</div>
            {activeRow.depthUsd != null && <div className="stat-sub">Pool liquidity {usdCompact(activeRow.depthUsd)}</div>}
          </div>
        </div>

        <div className="hero-actions">
          <button type="button" className="btn" onClick={scrollToLotLab}>
            Size a {activeRow.symbol} trade ↓
          </button>
          <ShareButton
            path={`/${activeRow.symbol}`}
            card={{ page: 'stock', sym: activeRow.symbol }}
            fileName={`afterbook-${activeRow.symbol}.png`}
            text={stockShareText(activeRow, tape)}
          />
          <a className="emph-link" href="https://t.me/afterbook_bot" target="_blank" rel="noopener noreferrer">
            Get alerts on Telegram&nbsp;<span className="ext-arrow">↗</span>
          </a>
        </div>
        <p className="hero-note">
          Onchain price is what the stock token trades for on Aero (formerly Aerodrome), the Base exchange that is open around the clock. 100 basis points (bp) = 1%. No wallet needed to browse; connect one only to see your lots or trade.
        </p>
        <ol className="how-steps" aria-label="How Afterbook works">
          <li>
            <span className="how-step-n">1</span>
            <span><strong>See the gap.</strong> The big number: how far the token&apos;s price is from the stock&apos;s.</span>
          </li>
          <li>
            <span className="how-step-n">2</span>
            <span><strong>Check the pool.</strong> Pool liquidity says how big a trade the price can take.</span>
          </li>
          <li>
            <span className="how-step-n">3</span>
            <span><strong>Trade from your wallet.</strong> Size it below, then buy or sell. No sign-up.</span>
          </li>
        </ol>
        {/* The words, for whoever wants them: closed by default, nothing remembered between visits. */}
        <details className="explain hero-intro">
          <summary>What the words mean</summary>
          <dl>
            <div>
              <dt>Tokenized stocks</dt>
              <dd>
                Tokens on Base that track a real stock, issued by Coinbase: {activeRow.symbol} tracks {activeRow.name}.
              </dd>
            </div>
            <div>
              <dt>Cash price</dt>
              <dd>The stock&apos;s price on the real stock market (Nasdaq or NYSE). It stops moving when that market closes.</dd>
            </div>
            <div>
              <dt>Onchain price</dt>
              <dd>What the token trades for on Aero (formerly Aerodrome), which never closes, so it keeps moving at night and over the weekend.</dd>
            </div>
            <div>
              <dt>The gap (bp)</dt>
              <dd>How far apart the two prices are, in basis points: 100 bp = 1%. Green: the token costs more than the stock; red: less.</dd>
            </div>
            <div>
              <dt>Wallet</dt>
              <dd>Not needed to look around. Connect one only to see your holdings or to trade.</dd>
            </div>
          </dl>
          <p className="explain-foot">Coinbase&apos;s stock tokens are not available to people in the United States.</p>
        </details>
      </section>
    )}

    <div className="compact-anchor">
    <div className={`sticky-symbol-bar${heroGone ? ' sticky-symbol-bar-on' : ''}`}>
      <div className="sticky-symbol-row">
        <select className="sticky-symbol-select" value={symbol} onChange={(e) => setSymbolAndUrl(e.target.value)} aria-label="Active symbol">
          <SymbolOptions liquidRows={liquidRows} thinRows={thinRows} />
        </select>
        {heroBp != null && <span className={`sticky-symbol-basis ${heroBp >= 0 ? 'basis-pos' : 'basis-neg'}`}>{bp(heroBp)}</span>}
      </div>
      {activeRow?.cashLastUsd != null && activeRow?.onchainMidUsd != null && (
        <div className="sticky-symbol-detail">
          <span className="gap-price-pair">
            <span className="gap-detail-label">cash</span> {usd(activeRow.cashLastUsd)}
          </span>
          {' → '}
          <span className="gap-price-pair">
            <span className="gap-detail-label">onchain</span> {usd(activeRow.onchainMidUsd)}
          </span>
        </div>
      )}
    </div>
    </div>
    </>
  );
}
