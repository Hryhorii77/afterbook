// The trade calculator's LP tab: the same size as a full-range deposit, the pool's liquidity by
// price with a draggable range, what that range would earn and risk, and the earnings comparison.
import type { CbStock } from '@/lib/tokens';
import { formatWindow, usd } from '@/lib/format';
import { IN_RANGE_HORIZON_DAYS } from '@/lib/volatilityMath';
import { DepthChart } from '../DepthChart';
import { shares } from './util';
import type { DepthResponse, EarningsMoveStats, PriceRange, QuoteResponse } from './types';

export interface RangeMetrics {
  multiplier: number | null;
  inRangeProbabilityPct: number | null;
  estimatedFeeAprPct: number | null;
  divergenceLoss: { atLowPct: number; atHighPct: number } | null;
}

export interface EarningsVolAnalysis {
  impliedHorizonDays: number | null;
  daysToEarnings: number | null;
}

interface Props {
  quote: QuoteResponse;
  symbol: string;
  activeStock: CbStock;
  depth: DepthResponse | null;
  selectedRange: PriceRange | null;
  setSelectedRange: (r: PriceRange) => void;
  adjustRangeMode: boolean;
  setAdjustRangeMode: (f: (v: boolean) => boolean) => void;
  rangeMetrics: RangeMetrics | null;
  earningsVolAnalysis: EarningsVolAnalysis | null;
  earningsStats: EarningsMoveStats | null;
}

export function LotLabLp({ quote, symbol, activeStock, depth, selectedRange, setSelectedRange, adjustRangeMode, setAdjustRangeMode, rangeMetrics, earningsVolAnalysis, earningsStats }: Props) {
  return (
    <>
      <div className="lp-line">
        <span className="lp-line-label">Same {usd(quote.usdcIn, 0)} as LP</span>
        <span className="lp-line-value">
          ≈ {usd(quote.usdcIn / 2, 0)} + {shares(quote.usdcIn / 2 / quote.midPriceUsd)} {activeStock.symbol}
        </span>
      </div>
      <p className="geo-note">
        Full-range, ~50/50 by value at the current price — a full-range concentrated-liquidity position is
        mathematically equivalent to a classic 50/50 pool. Aero and Aerodrome default new deposits to a narrower
        range, which would change this split; check the actual range before depositing.
      </p>

      {depth && depth.symbol === symbol && (
        <>
          <div className="depth-heading-row">
            <h3 className="depth-heading">Liquidity depth · LP range selector</h3>
            <button
              type="button"
              className={adjustRangeMode ? 'adjust-range-toggle adjust-range-toggle-active' : 'adjust-range-toggle'}
              onClick={() => setAdjustRangeMode((v) => !v)}
            >
              {adjustRangeMode ? 'Done adjusting' : 'Adjust range'}
            </button>
          </div>
          <DepthChart
            buckets={depth.buckets}
            currentPriceUsd={depth.currentPriceUsd}
            selectedRange={selectedRange ?? undefined}
            onRangeChange={setSelectedRange}
            dragEnabled={adjustRangeMode}
          />
          <p className="geo-note">
            Active on-chain liquidity by price, read directly from the pool&apos;s tick data — taller bars are
            where support/resistance walls actually sit. Dashed line marks the current price.{' '}
            {adjustRangeMode
              ? 'Drag the two green handles to size a candidate LP range.'
              : 'Tap "Adjust range" above to drag the green handles — off by default so the chart doesn’t fight scrolling on mobile.'}
          </p>

          {rangeMetrics && selectedRange && (
            <>
              <div className="result-grid">
                <div className="result-cell">
                  <div className="label">Selected range</div>
                  <div className="value">
                    {usd(selectedRange.lowUsd, 0)} – {usd(selectedRange.highUsd, 0)}
                  </div>
                </div>
                <div className="result-cell">
                  <div className="label">Capital efficiency</div>
                  <div className="value">{rangeMetrics.multiplier != null ? `${rangeMetrics.multiplier.toFixed(1)}×` : '—'}</div>
                </div>
                <div className="result-cell">
                  <div className="label">
                    Est. fee APR
                    {depth.feeAprWindowDays != null
                      ? ` (last ${formatWindow(depth.feeAprWindowDays)}${depth.feeAprEstimated ? ', prelim.' : ''})`
                      : ''}
                  </div>
                  <div className="value">{rangeMetrics.estimatedFeeAprPct != null ? `${rangeMetrics.estimatedFeeAprPct.toFixed(1)}%` : '—'}</div>
                </div>
                <div className="result-cell">
                  <div className="label">In-range prob. ({IN_RANGE_HORIZON_DAYS}d)</div>
                  <div className="value">
                    {rangeMetrics.inRangeProbabilityPct != null ? `${rangeMetrics.inRangeProbabilityPct.toFixed(0)}%` : '—'}
                  </div>
                </div>
                <div className="result-cell">
                  <div className="label">Divergence loss at boundary</div>
                  <div className="value">
                    {rangeMetrics.divergenceLoss != null
                      ? `${rangeMetrics.divergenceLoss.atLowPct.toFixed(1)}% / ${rangeMetrics.divergenceLoss.atHighPct.toFixed(1)}%`
                      : '—'}
                  </div>
                </div>
              </div>
              <p className="geo-note">
                Capital efficiency: how much more liquidity this range buys vs. a full-range position for the
                same deposit, from the range width alone. Est. fee APR: what one unit of unstaked liquidity
                actually earned in fees over the window (the pool&apos;s own fee counter), as the APR of a full-range
                position, times that multiplier. It assumes the price stays in range and you don&apos;t stake; staked
                liquidity earns AERO instead of these fees. An extrapolation, not a guarantee.
                {depth.feeAprEstimated &&
                  ' "Prelim." means there isn’t enough feeGrowth snapshot history yet (a fresh deploy, or a pool that only recently got worth tracking) — this is a rougher stand-in estimated from actual swap volume over the last hour or so instead, replaced automatically by the real multi-day figure once enough snapshots accumulate.'}{' '}
                In-range probability: chance the
                price is still inside this range in {IN_RANGE_HORIZON_DAYS} days, from recent realized
                volatility — both null until enough history has accumulated for this symbol. Divergence loss
                at boundary: value lost vs. simply holding the position&apos;s initial split (low% / high%),
                if price reaches exactly the low or high edge of this range — the standard concentrated-
                liquidity impermanent-loss benchmark, not fees (which offset it separately, tracked above).
                A move that continues past either edge doesn&apos;t add further divergence loss from the pool
                itself — the position has already fully converted to one asset by then and just tracks its
                price directly, same as holding it outside the pool.
              </p>
              <div className="carry-hedge-note">
                <h4>Auto-recenter (optional, off-app)</h4>
                <p className="geo-note" style={{ marginTop: 0 }}>
                  Once price exits this range, the position stops earning fees and starts accumulating the
                  divergence loss above if it stays out. Re-centering means withdrawing the position,
                  swapping back toward ~50/50 at the new price, and redepositing a fresh range around
                  it — the same three steps a manual LP would do by hand. Afterbook doesn&apos;t build or
                  run this: any automation that does it for you needs to construct and submit that
                  withdraw/swap/redeploy calldata autonomously — the same problem the{' '}
                  <code>execute-link</code> agent endpoint hit (this app has no confirmed-working router
                  for these specific pools outside the exchange&apos;s own site), which any real
                  automation would have to solve for itself before it could safely trigger anything.
                </p>
                <p className="geo-note">
                  Where to build one:{' '}
                  <a className="emph-link" href="https://docs.gelato.cloud/web3-functions/introduction/overview" target="_blank" rel="noopener noreferrer">
                    Gelato Web3 Functions&nbsp;<span className="ext-arrow">↗</span>
                  </a>{' '}
                  (general-purpose on-chain automation — watch the pool&apos;s tick, trigger a re-center
                  transaction when it exits your range) ·{' '}
                  <a className="emph-link" href="https://bankr.bot/" target="_blank" rel="noopener noreferrer">
                    Bankr&nbsp;<span className="ext-arrow">↗</span>
                  </a>{' '}
                  (Base-native AI trading agent via Farcaster/X chat — its documented capabilities are
                  swaps, limit orders, and DCA, not LP range management, as of writing; check its current
                  feature set before assuming it covers this).
                </p>
                <p className="geo-note">
                  Not a recommendation to use either, and Afterbook has no relationship with them — any
                  automation you set up needs its own funded wallet and its own security review; this app
                  doesn&apos;t hold keys for you and never will.
                </p>
              </div>
            </>
          )}

          {earningsVolAnalysis && (
            <>
              <h3 className="depth-heading">Earnings volatility spread</h3>
              <div className="result-grid">
                <div className="result-cell">
                  <div className="label">Liquidity-implied horizon</div>
                  <div className="value">
                    {earningsVolAnalysis.impliedHorizonDays != null ? `${earningsVolAnalysis.impliedHorizonDays.toFixed(1)}d` : '—'}
                  </div>
                </div>
                <div className="result-cell">
                  <div className="label">Days to earnings</div>
                  <div className="value">
                    {earningsVolAnalysis.daysToEarnings != null && earningsVolAnalysis.daysToEarnings >= 0
                      ? `${earningsVolAnalysis.daysToEarnings}d`
                      : '—'}
                  </div>
                </div>
                <div className="result-cell">
                  <div className="label">Historical avg move (day after)</div>
                  <div className="value">{earningsStats ? `±${earningsStats.meanAbsMovePct.toFixed(1)}% (n=${earningsStats.count})` : '—'}</div>
                </div>
              </div>
              {earningsVolAnalysis.impliedHorizonDays != null &&
                earningsVolAnalysis.daysToEarnings != null &&
                earningsVolAnalysis.daysToEarnings >= 0 && (
                  <p className="geo-note">
                    {earningsVolAnalysis.impliedHorizonDays < earningsVolAnalysis.daysToEarnings * 0.7
                      ? `Pool liquidity is concentrated as tightly as ~${earningsVolAnalysis.impliedHorizonDays.toFixed(0)}d of typical moves would justify — shorter than the ${earningsVolAnalysis.daysToEarnings}d until earnings, so the pool may be thinner than what the upcoming report could`
                      : earningsVolAnalysis.impliedHorizonDays > earningsVolAnalysis.daysToEarnings * 1.4
                        ? `Pool liquidity is spread as wide as ~${earningsVolAnalysis.impliedHorizonDays.toFixed(0)}d of typical moves would justify — wider than the ${earningsVolAnalysis.daysToEarnings}d until earnings, so it may already be pricing in more than a typical report would`
                        : `Pool liquidity is concentrated about as tightly as ~${earningsVolAnalysis.impliedHorizonDays.toFixed(0)}d of typical moves would justify — roughly in line with the ${earningsVolAnalysis.daysToEarnings}d until earnings`}
                    {' '}warrant, relative to what post-earnings moves have actually looked like historically.
                  </p>
                )}
              <p className="geo-note">
                Not implied volatility in the options-market sense — there&apos;s no options market here.
                This reads how tightly LPs have clustered their own liquidity as the number of days of{' '}
                {activeStock.cashTicker}&apos;s realized volatility that concentration would justify, then
                compares that to the real days until the next report and, when available, the average size
                of this stock&apos;s past post-earnings moves. All three numbers are shown raw on purpose —
                not investment advice, and a real earnings move can differ arbitrarily from history.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
