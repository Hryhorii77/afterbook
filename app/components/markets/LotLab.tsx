// The trade calculator ("Lot Lab", id lot-lab): pick a stock and a USDC size, then three tabs:
// Trade (shares out, impact, the impact curve), LP (LotLabLp) and Carry (LotLabCarry, only while
// cash is closed with a wide gap). Each tab is rendered only while open.
import { useEffect, useMemo, useRef, useState } from 'react';
import { poolVenue, type CbStock } from '@/lib/stocks/tokens';
import type { TapeResult, TapeRow } from '@/lib/market/tape';
import { bp, usd, usdCompact } from '@/lib/format';
import { computeCashAndCarryEdge } from '@/lib/market/arb';
import { computeInRangeProbabilityPct, solveImpliedHorizonDays } from '@/lib/market/volatilityMath';
import { capitalEfficiencyMultiplier, computeDivergenceLossAtBoundary, computeLiquidityConcentrationRange, rangeAprPct } from '@/lib/lp/lpRange';
import { ImpactCurve } from './ImpactCurve';
import { daysUntil, EARNINGS_CAVEAT_WINDOW_DAYS } from './Tape';
import { SymbolOptions } from './SymbolOptions';
import { LotLabLp } from './LotLabLp';
import { LotLabCarry } from './LotLabCarry';
import { SIZE_PRESETS_USDC, shares, useCopy } from './util';
import type { DepthResponse, EarningsMoveStats, PriceRange, PriceSample, QuoteResponse } from './types';

interface Props {
  tape: TapeResult;
  symbol: string;
  setSymbolAndUrl: (sym: string) => void;
  activeRow: TapeRow | undefined;
  activeStock: CbStock;
  liquidRows: TapeRow[];
  thinRows: TapeRow[];
  usdcInput: string;
  setUsdcInput: (v: string) => void;
  quote: QuoteResponse | null;
  quoteError: string | null;
  depth: DepthResponse | null;
  priceHistory: PriceSample[];
  earningsStats: EarningsMoveStats | null;
  now: number;
  unlocked: boolean;
}

export function LotLab({ tape, symbol, setSymbolAndUrl, activeRow, activeStock, liquidRows, thinRows, usdcInput, setUsdcInput, quote, quoteError, depth, priceHistory, earningsStats, now, unlocked }: Props) {
  const [lotLabTab, setLotLabTab] = useState<'trade' | 'lp' | 'carry'>('trade');
  const [selectedRange, setSelectedRange] = useState<PriceRange | null>(null);
  const selectedRangeSymbolRef = useRef<string | null>(null);
  // Off by default so a finger landing on the chart while scrolling the
  // page on mobile scrolls the page, not the range — the depth chart's
  // touch-action: none while dragging is active would otherwise fight
  // native scroll gestures. Desktop mouse dragging never had this
  // conflict, but the same explicit toggle covers both for one UX rather
  // than branching on input type.
  const [adjustRangeMode, setAdjustRangeMode] = useState(false);
  const { copied, copy } = useCopy();

  // Defaults the range selector to ±10% around current price exactly once
  // per symbol (on the first depth response for it) — not on every 60s
  // depth poll, which would stomp an in-progress drag.
  useEffect(() => {
    if (depth && depth.symbol === symbol && selectedRangeSymbolRef.current !== symbol) {
      setSelectedRange({ lowUsd: depth.currentPriceUsd * 0.9, highUsd: depth.currentPriceUsd * 1.1 });
      selectedRangeSymbolRef.current = symbol;
    }
  }, [depth, symbol]);

  // Carry only earns its place as a tab when there's an edge worth
  // sizing — cash closed plus a basis spread wide enough to plausibly
  // clear fees/impact/gas. 20bp is a display threshold, not the exact
  // breakeven (that varies by trade size); the Carry tab's own numbers
  // remain the source of truth once opened.
  const carryEligible = tape.session.state !== 'open' && activeRow?.basisBp != null && Math.abs(activeRow.basisBp) > 20;

  // BNKR feedback: a premium (basisBp > 0) has no edge for a buy — that
  // direction only pays off for someone who already holds shares and
  // wants to unwind that inventory into the rich on-chain price instead.
  // Defaults to whichever side actually has an edge for the active
  // symbol's current basis; only resets on a symbol switch, not on every
  // basis tick, so it doesn't yank the toggle out from under someone
  // mid-read if the sign flips transiently.
  const [carryDirection, setCarryDirection] = useState<'buy' | 'sell'>('buy');
  useEffect(() => {
    setCarryDirection((tape.rows.find((r) => r.symbol === symbol)?.basisBp ?? 0) > 0 ? 'sell' : 'buy');
  }, [symbol]);

  useEffect(() => {
    if (lotLabTab === 'carry' && !carryEligible) setLotLabTab('trade');
  }, [carryEligible, lotLabTab]);

  // Only meaningful while cash is closed — once it's open there's no
  // "carry until reopen" window left to annualize over.
  const arbEdge = useMemo(() => {
    if (tape.session.state === 'open' || !quote || activeRow?.basisBp == null) return null;
    const msUntilOpen = new Date(tape.session.nextOpenIso).getTime() - now;
    return computeCashAndCarryEdge(activeRow.basisBp, quote.feeBp, quote.impactBp, quote.usdcIn, msUntilOpen, carryDirection);
  }, [tape.session.state, tape.session.nextOpenIso, quote, activeRow?.basisBp, now, carryDirection]);

  // Live math behind the depth chart's drag handles — recomputed on every
  // frame of a drag, purely client-side (no request per pixel of movement).
  const rangeMetrics = useMemo(() => {
    if (!selectedRange || !depth || depth.symbol !== symbol) return null;
    const multiplier = capitalEfficiencyMultiplier(selectedRange.lowUsd, selectedRange.highUsd, depth.currentPriceUsd);
    const inRangeProbabilityPct = computeInRangeProbabilityPct(priceHistory, depth.currentPriceUsd, selectedRange.lowUsd, selectedRange.highUsd);
    const estimatedFeeAprPct =
      depth.fullRangeFeeAprPct != null ? rangeAprPct(depth.fullRangeFeeAprPct, selectedRange.lowUsd, selectedRange.highUsd, depth.currentPriceUsd) : null;
    const divergenceLoss = computeDivergenceLossAtBoundary(selectedRange.lowUsd, selectedRange.highUsd, depth.currentPriceUsd);
    return { multiplier, inRangeProbabilityPct, estimatedFeeAprPct, divergenceLoss };
  }, [selectedRange, depth, symbol, priceHistory]);

  // How many days of this token's realized volatility the pool's own
  // liquidity concentration would justify, vs. the real days-until-
  // earnings — see lib/lp/lpRange.ts and lib/market/volatilityMath.ts for why this
  // is framed as a horizon comparison rather than a fabricated "implied
  // volatility" number (there's no options market here to price one).
  const earningsVolAnalysis = useMemo(() => {
    if (!depth || depth.symbol !== symbol) return null;
    const concentration = computeLiquidityConcentrationRange(depth.buckets, depth.currentTick, 0.68);
    if (!concentration) return null;
    const impliedHorizonDays = solveImpliedHorizonDays(
      priceHistory,
      depth.currentPriceUsd,
      concentration.lowUsd,
      concentration.highUsd,
      concentration.actualFraction * 100,
    );
    const daysToEarnings = activeRow?.nextEarningsDate != null ? daysUntil(activeRow.nextEarningsDate) : null;
    return { concentration, impliedHorizonDays, daysToEarnings };
  }, [depth, symbol, priceHistory, activeRow?.nextEarningsDate]);

  const copyTrade = () => {
    if (quote) void copy(`Buy ${shares(quote.sharesOut)} ${activeStock.symbol} for ${usd(quote.usdcIn, 0)} USDC`);
  };

  return (
    <section className="panel" id="lot-lab">
      <h2>Trade calculator</h2>
      <div className="lot-lab-form">
        <div className="field">
          <label htmlFor="symbol-select">Stock</label>
          <select id="symbol-select" value={symbol} onChange={(e) => setSymbolAndUrl(e.target.value)}>
            <SymbolOptions liquidRows={liquidRows} thinRows={thinRows} />
          </select>
        </div>
        <div className="field">
          <label htmlFor="usdc-input">USDC in</label>
          <input
            id="usdc-input"
            type="number"
            min={1}
            step="1"
            value={usdcInput}
            onChange={(e) => setUsdcInput(e.target.value)}
          />
        </div>
      </div>

      <div className="size-presets">
        {SIZE_PRESETS_USDC.map((amt) => (
          <button
            key={amt}
            type="button"
            className={String(amt) === usdcInput ? 'preset-btn preset-btn-active' : 'preset-btn'}
            onClick={() => setUsdcInput(String(amt))}
          >
            {usdCompact(amt)}
          </button>
        ))}
        {activeRow?.depthUsd != null &&
          (() => {
            const onePctOfPool = String(Math.max(1, Math.round(activeRow.depthUsd! * 0.01)));
            return (
              <button
                type="button"
                className={onePctOfPool === usdcInput ? 'preset-btn preset-btn-active' : 'preset-btn'}
                onClick={() => setUsdcInput(onePctOfPool)}
              >
                1% of pool
              </button>
            );
          })()}
      </div>

      {quoteError && <p className="geo-note">{quoteError}</p>}

      {quote && (
        <>
          <div className="lot-lab-tabs" role="tablist">
            {(carryEligible ? (['trade', 'lp', 'carry'] as const) : (['trade', 'lp'] as const)).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={lotLabTab === tab}
                className={lotLabTab === tab ? 'lot-lab-tab lot-lab-tab-active' : 'lot-lab-tab'}
                onClick={() => setLotLabTab(tab)}
              >
                {tab === 'trade' ? 'Trade' : tab === 'lp' ? 'LP' : 'Carry'}
              </button>
            ))}
          </div>

          {lotLabTab === 'trade' && (
            <>
              <div className="result-hero">
                <div>
                  <div className="label">Shares out</div>
                  <div className="value">{shares(quote.sharesOut)}</div>
                </div>
                <button type="button" className="btn btn-secondary" onClick={copyTrade}>
                  {copied ? 'Copied' : 'Copy trade'}
                </button>
              </div>
              <div className="result-grid">
                <div className="result-cell">
                  <div className="label">Exec price</div>
                  <div className="value">{usd(quote.execPriceUsd)}</div>
                </div>
                <div className="result-cell">
                  <div className="label">Impact</div>
                  <div className="value">{quote.largeTradeCaveat ? '≥ ' : ''}{bp(quote.impactBp)}</div>
                </div>
                <div className="result-cell">
                  <div className="label">Pool fee</div>
                  <div className="value">{quote.feeBp.toFixed(0)} bp</div>
                </div>
              </div>

              <ImpactCurve points={quote.curve} currentUsdcIn={quote.usdcIn} currentImpactBp={quote.impactBp} />

              {quote.largeTradeCaveat && (
                <p className="geo-note">
                  This trade runs past the liquidity Afterbook reads (25% from the current price), so the real
                  fill on {poolVenue(activeStock)} would be worse than this estimate.
                </p>
              )}
              <details className="geo-more">
                <summary>More</summary>
                <p className="geo-note">
                  Estimated from the pool&apos;s current on-chain price and in-range liquidity — not a firm
                  quote. Shaded region on the curve above: sizes where the estimate is less reliable for the
                  same reason.
                </p>
              </details>
              {activeRow?.nextEarningsDate != null && daysUntil(activeRow.nextEarningsDate) <= EARNINGS_CAVEAT_WINDOW_DAYS && daysUntil(activeRow.nextEarningsDate) >= 0 && (
                <p className="geo-note">
                  {activeStock.cashTicker} reports earnings in {daysUntil(activeRow.nextEarningsDate)} day
                  {daysUntil(activeRow.nextEarningsDate) === 1 ? '' : 's'} — expect wider spreads and more volatility
                  than this estimate reflects.
                </p>
              )}
            </>
          )}

          {lotLabTab === 'lp' && (
            <LotLabLp
              quote={quote}
              symbol={symbol}
              activeStock={activeStock}
              depth={depth}
              selectedRange={selectedRange}
              setSelectedRange={setSelectedRange}
              adjustRangeMode={adjustRangeMode}
              setAdjustRangeMode={setAdjustRangeMode}
              rangeMetrics={rangeMetrics}
              earningsVolAnalysis={earningsVolAnalysis}
              earningsStats={earningsStats}
            />
          )}

          {lotLabTab === 'carry' && (
            <LotLabCarry
              arbEdge={arbEdge}
              carryDirection={carryDirection}
              setCarryDirection={setCarryDirection}
              activeStock={activeStock}
              quote={quote}
              unlocked={unlocked}
            />
          )}
        </>
      )}
    </section>
  );
}
