import type { Metadata } from 'next';
import Link from 'next/link';
import { SymbolTile } from '@/app/components/SymbolTile';
import { BorrowCalculator, type CalculatorMarket } from '@/app/components/BorrowCalculator';
import { getAllLiquidationRisk } from '@/lib/liquidationRisk';
import { morphoMarketUrl } from '@/lib/morpho';
import { liquidationIncentiveFactor } from '@/lib/liquidationMath';
import { getGeoInfo } from '@/lib/geo';
import { getStock } from '@/lib/tokens';
import { bp, usdCompact } from '@/lib/format';

// Live pool and oracle reads on every request (each cached 20–60s
// underneath), same as /today.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Borrow against stocks — Afterbook',
  description:
    "Morpho's USDC loans against Base tokenized stocks, and whether Aerodrome is deep enough to absorb their liquidations.",
};

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export default async function BorrowPage() {
  const [risks, geo] = await Promise.all([getAllLiquidationRisk().catch(() => null), getGeoInfo()]);
  const markets = (risks ?? [])
    .flatMap((r) => r.markets)
    .sort((a, b) => b.collateralUsd - a.collateralUsd || b.lltv - a.lltv);
  // Markets nobody has borrowed in yet get one line, not a card of zeros
  // (Morpho's API also reports a meaningless utilization for them).
  const active = markets.filter((m) => m.collateralUsd >= 1);
  const empty = markets.filter((m) => m.collateralUsd < 1);
  const totalCollateral = markets.reduce((s, m) => s + m.collateralUsd, 0);
  const totalBorrow = markets.reduce((s, m) => s + m.borrowUsd, 0);

  const calcMarkets: CalculatorMarket[] = markets.map((m) => ({
    marketId: m.marketId,
    symbol: m.symbol,
    lltv: m.lltv,
    oraclePriceUsd: m.oraclePriceUsd,
    aeroVsOracleBp: m.aeroVsOracleBp,
  }));
  const curves = Object.fromEntries((risks ?? []).map((r) => [r.symbol, r.sellCurve]));

  return (
    <main>
      <header className="top">
        <h1>Borrow against stocks</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Morpho lets you borrow USDC against these stock tokens. If the price falls far enough, a liquidator repays your
        loan, takes your stock at a discount and usually sells it on Aerodrome. This page shows whether those pools are
        deep enough for that sale to happen.
      </p>

      {!risks ? (
        <section className="panel">
          <p className="geo-note">Lending data unavailable right now. Try again shortly.</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="stat-grid" style={{ marginTop: 0 }}>
              <div className="stat-card">
                <div className="stat-value">{usdCompact(totalCollateral)}</div>
                <div className="stat-label">Stock posted as collateral</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{usdCompact(totalBorrow)}</div>
                <div className="stat-label">USDC borrowed against it</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{markets.length}</div>
                <div className="stat-label">Listed Morpho markets on Base</div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Markets</h2>
            <p className="geo-note" style={{ marginTop: 0 }}>
              &ldquo;Aero can absorb&rdquo; is the most stock a liquidator could sell on Aerodrome right now and still make
              money, after the price impact and the pool fee. The bar shows how much of that this market&apos;s collateral
              would use.
            </p>
            <div className="weight-grid">
              {active.map((m) => {
                const stock = getStock(m.symbol);
                const used = m.profitableLiquidationCapacityUsd > 0 ? m.collateralUsd / m.profitableLiquidationCapacityUsd : 1;
                return (
                  <div className="weight-card" key={m.marketId}>
                    <div className="weight-card-top">
                      <SymbolTile cashTicker={stock?.cashTicker ?? m.symbol} />
                      <div className="sym-cell-text">
                        <span className="symbol">{m.symbol}</span>
                        <span className="symbol-name">Max LTV {pct(m.lltv)}</span>
                      </div>
                    </div>
                    <div className="weight-pct">{pct(m.borrowApy, 2)}</div>
                    <div className="weight-meta" style={{ marginTop: 2 }}>
                      <span>Borrow rate</span>
                      <span>Lenders earn {pct(m.supplyApy, 2)}</span>
                    </div>
                    <div className="weight-meta">
                      <span>Collateral</span>
                      <span>{usdCompact(m.collateralUsd)}</span>
                    </div>
                    <div className="weight-meta">
                      <span>Borrowed</span>
                      <span>
                        {usdCompact(m.borrowUsd)} ({pct(m.utilization, 0)} used)
                      </span>
                    </div>
                    <div className="weight-meta">
                      <span>Aero vs oracle</span>
                      <span className={m.aeroVsOracleBp >= 0 ? 'basis-pos' : 'basis-neg'}>{bp(m.aeroVsOracleBp)}</span>
                    </div>
                    <div className="weight-meta">
                      <span>Aero can absorb</span>
                      <span>
                        {m.capacityIsLowerBound ? '≈ ' : ''}
                        {usdCompact(m.profitableLiquidationCapacityUsd)}
                      </span>
                    </div>
                    <div className="weight-bar" aria-label={`Collateral is ${pct(Math.min(used, 1), 0)} of what Aerodrome can absorb`}>
                      <span style={{ width: `${Math.max(1, Math.min(100, used * 100))}%` }} />
                    </div>
                    {geo.nonUs && (
                      <div className="weight-meta">
                        <a className="emph-link" href={morphoMarketUrl(m.marketId)} target="_blank" rel="noopener noreferrer">
                          Open on Morpho
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {empty.length > 0 && (
              <p className="geo-note">
                Also listed, no loans yet:{' '}
                {empty.map((m, i) => (
                  <span key={m.marketId}>
                    {i > 0 && ', '}
                    {geo.nonUs ? (
                      <a className="emph-link" href={morphoMarketUrl(m.marketId)} target="_blank" rel="noopener noreferrer">
                        {m.symbol} ({pct(m.lltv)})
                      </a>
                    ) : (
                      `${m.symbol} (${pct(m.lltv)})`
                    )}
                  </span>
                ))}
                .
              </p>
            )}
            {active.some((m) => m.capacityIsLowerBound) && (
              <p className="geo-note">
                &asymp; means the sale would still pay until the pool runs out of USDC near the price, so the figure is about
                all the USDC that pool holds.
              </p>
            )}
          </section>

          {calcMarkets.length > 0 && (
            <section className="panel">
              <h2>Check a loan</h2>
              <BorrowCalculator markets={calcMarkets} curves={curves} />
            </section>
          )}

          <section className="panel">
            <h2>How this is worked out</h2>
            <ul className="geo-note">
              <li>
                Markets, rates and totals come from Morpho&apos;s public API. Only markets Morpho lists are shown. The oracle
                price, the one liquidations use, is read from each market&apos;s oracle on Base.
              </li>
              <li>
                A liquidator repaying a loan gets the stock at a bonus set by the market: about{' '}
                {pct(liquidationIncentiveFactor(0.625) - 1, 1)} at a 62.5% max LTV and{' '}
                {pct(liquidationIncentiveFactor(0.77) - 1, 1)} at 77%.
                Selling on Aerodrome pays only if the average fill stays within that bonus, after the gap between the pool
                and the oracle.
              </li>
              <li>
                Fills are simulated against the pool&apos;s real liquidity, tick by tick, within 25% of the current price.
                The loan check assumes the pool looks the same at your liquidation price as it does now. In a real sell-off
                it is usually thinner.
              </li>
              <li>
                Afterbook does not lend, borrow or hold anything here. Borrowing can lose you your collateral. This is not
                advice. Coinbase&apos;s stock tokens are not available to people in the United States.
              </li>
            </ul>
            <p className="geo-note">
              Agents and bots can get the same numbers per stock, with a position check, from the paid API at{' '}
              <code>/api/v1/x402/liquidation-capacity</code>.
            </p>
          </section>
        </>
      )}

      <p className="geo-note">
        <Link href="/" className="page-link">
          Open the Tape <span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
