// The trade calculator's Carry tab (only while cash is closed and the gap is wide): what buying or
// unwinding now and holding to the reopen would earn after fees, impact and gas.
import { aerodromeSwapUrl, type CbStock } from '@/lib/tokens';
import { bp, usd } from '@/lib/format';
import { GAS_ESTIMATE_USD, type computeCashAndCarryEdge } from '@/lib/arb';
import { logOutboundClick } from './util';
import type { QuoteResponse } from './types';

interface Props {
  arbEdge: ReturnType<typeof computeCashAndCarryEdge> | null;
  carryDirection: 'buy' | 'sell';
  setCarryDirection: (d: 'buy' | 'sell') => void;
  activeStock: CbStock;
  quote: QuoteResponse;
  unlocked: boolean;
}

export function LotLabCarry({ arbEdge, carryDirection, setCarryDirection, activeStock, quote, unlocked }: Props) {
  if (!arbEdge) {
    return (
      <p className="geo-note">
        Only meaningful while cash is closed — {activeStock.symbol} has no carry edge to show while the
        regular session is open. Check back after hours or on a weekend.
      </p>
    );
  }
  return (
    <>
      <div className="carry-direction-toggle" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={carryDirection === 'buy'}
          className={carryDirection === 'buy' ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
          onClick={() => setCarryDirection('buy')}
        >
          Buy basis
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={carryDirection === 'sell'}
          className={carryDirection === 'sell' ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
          onClick={() => setCarryDirection('sell')}
        >
          Short basis / unwind
        </button>
      </div>
      <div className="result-hero">
        <div>
          <div className="label">Annualized, held to reopen</div>
          <div className={`value ${arbEdge.annualizedPct != null && arbEdge.annualizedPct >= 0 ? 'basis-pos' : 'basis-neg'}`}>
            {arbEdge.annualizedPct == null
              ? '—'
              : `${arbEdge.annualizedPct >= 0 ? '+' : ''}${arbEdge.annualizedPct.toFixed(
                  Math.abs(arbEdge.annualizedPct) < 1 ? 2 : Math.abs(arbEdge.annualizedPct) < 10 ? 1 : 0,
                )}%`}
          </div>
        </div>
      </div>
      <div className="result-grid">
        <div className="result-cell">
          <div className="label">Gross basis edge</div>
          <div className={`value ${arbEdge.grossEdgeBp >= 0 ? 'basis-pos' : 'basis-neg'}`}>{bp(arbEdge.grossEdgeBp)}</div>
        </div>
        <div className="result-cell">
          <div className="label">Pool fee</div>
          <div className="value">-{arbEdge.feeBp.toFixed(1)} bp</div>
        </div>
        <div className="result-cell">
          <div className="label">Price impact</div>
          <div className="value">-{arbEdge.impactBp.toFixed(1)} bp</div>
        </div>
        <div className="result-cell">
          <div className="label">Est. gas ({usd(GAS_ESTIMATE_USD)})</div>
          <div className="value">-{arbEdge.gasBp.toFixed(1)} bp</div>
        </div>
        <div className="result-cell">
          <div className="label">Net edge</div>
          <div className={`value ${arbEdge.netEdgeBp >= 0 ? 'basis-pos' : 'basis-neg'}`}>{bp(arbEdge.netEdgeBp)}</div>
        </div>
      </div>
      {carryDirection === 'buy' ? (
        <p className="geo-note">
          Assumes buying {activeStock.symbol} now at this size and full convergence to the current cash
          reference by reopen — not guaranteed, and this app can only go long (no short leg), so a
          negative gross basis edge (on-chain priced above cash) has no offsetting trade here. Gas is a
          flat estimate for a typical Base swap, not simulated for this specific trade.
        </p>
      ) : (
        <p className="geo-note">
          For unwinding inventory you already hold, not opening a new short — this app has no borrow/short
          mechanism. Assumes selling {activeStock.symbol} now at this size and rebuying the same USDC
          notional in cash pre-market once it reopens, capturing the current premium — not guaranteed,
          and a negative gross basis edge (on-chain priced below cash) has no offsetting trade here. Gas
          is a flat estimate for a typical Base swap, not simulated for this specific trade.
        </p>
      )}
      <p className="geo-note">
        The annualized figure extrapolates the real {arbEdge.holdingDays.toFixed(1)}-day expected return (
        {arbEdge.netEdgeBp >= 0 ? '+' : ''}
        {(arbEdge.netEdgeBp / 100).toFixed(2)}%, from the net edge above) out to a full year for
        comparison — over a short window like this one, that extrapolation can look far larger than the
        real amount at stake. It isn&apos;t a claim you&apos;d gain or lose that much; the {arbEdge.holdingDays.toFixed(1)}-day
        figure is the one that actually applies here.
      </p>
      {carryDirection === 'sell' && unlocked && (
        <a
          className="btn"
          href={aerodromeSwapUrl(activeStock, 'sell')}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => logOutboundClick(activeStock.symbol, quote?.usdcIn ?? null, 'aerodrome-swap', 'sell')}
        >
          Sell {activeStock.symbol} on Aerodrome&nbsp;<span className="ext-arrow">↗</span>
        </a>
      )}
      <div className="carry-hedge-note">
        <h4>Delta-neutral hedge (optional, off-app)</h4>
        <p className="geo-note" style={{ marginTop: 0 }}>
          Holding the on-chain leg until reopen carries {activeStock.symbol}&apos;s own price risk on top
          of the basis edge above — it can move against you regardless of whether the basis converges as
          expected. Pairing this with a same-notional {activeStock.cashTicker} perp{' '}
          {carryDirection === 'buy' ? 'short' : 'long'} on a venue that actually lists one removes that
          directional exposure, leaving roughly just the basis edge minus perp funding — funding isn&apos;t
          in the numbers above (this app has no live funding-rate source, see below), so check it before
          sizing anything.
        </p>
        <p className="geo-note">
          Where to check:{' '}
          <a className="emph-link" href="https://hyperliquid.xyz/" target="_blank" rel="noopener noreferrer">
            Hyperliquid&nbsp;<span className="ext-arrow">↗</span>
          </a>{' '}
          (powers Base App&apos;s own tokenized-stock perps, same non-US eligibility gate this app
          uses) ·{' '}
          <a className="emph-link" href="https://avantis.finance" target="_blank" rel="noopener noreferrer">
            Avantis&nbsp;<span className="ext-arrow">↗</span>
          </a>{' '}
          (lists stocks among its markets — on Arbitrum, a different chain than these B20 pools) ·{' '}
          <a className="emph-link" href="https://synthetix.io/" target="_blank" rel="noopener noreferrer">
            Synthetix&nbsp;<span className="ext-arrow">↗</span>
          </a>{' '}
          (a real perp venue live on Base; no confirmed stock-specific market as of writing — check
          what&apos;s actually listed).
        </p>
        <p className="geo-note">
          Not investment advice, and Afterbook has no relationship with any of these venues — verify each
          independently, including whether a market for this specific stock actually exists there,
          before using any of them. This app deliberately avoids third-party price/data APIs (see
          README), so it can&apos;t show live funding rates itself; the net edge above reflects the
          on-chain leg&apos;s fees, impact, and gas only.
        </p>
      </div>
    </>
  );
}
