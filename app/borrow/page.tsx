import type { Metadata } from 'next';
import Link from 'next/link';
import { SymbolTile } from '@/app/components/SymbolTile';
import { BorrowCalculator, type CalculatorMarket } from '@/app/components/BorrowCalculator';
import { getAllLiquidationRisk } from '@/lib/liquidationRisk';
import { liquidationIncentiveFactor } from '@/lib/liquidationMath';
import type { LendingVenue } from '@/lib/lendingMarket';
import { getGeoInfo } from '@/lib/geo';
import { getStock } from '@/lib/tokens';
import { bp, usdCompact } from '@/lib/format';
import { shareMetadata } from '@/lib/shareMeta';
import { ShareButton } from '@/app/components/ShareButton';
import { aeroExit, borrowShareText, summarizeBorrow, venueName } from '@/lib/borrowSummary';

// Live pool and oracle reads on every request (each cached 20–60s
// underneath), same as /today.
export const dynamic = 'force-dynamic';

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  return shareMetadata({
    title: 'Borrow against stocks — Afterbook',
    description:
      "Morpho and Aave USDC loans against Base tokenized stocks, and whether Aerodrome is deep enough to absorb their liquidations.",
    path: '/borrow',
    card: { page: 'borrow' },
    searchParams: await searchParams,
  });
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export default async function BorrowPage() {
  const [all, geo] = await Promise.all([getAllLiquidationRisk().catch(() => null), getGeoInfo()]);
  const risks = all?.stocks ?? null;
  const aaveHub = all?.aaveHub ?? null;
  const markets = (risks ?? [])
    .flatMap((r) => r.markets)
    .sort((a, b) => b.collateralUsd - a.collateralUsd || b.lltv - a.lltv);
  // Markets nobody has borrowed in yet get one line, not a card of zeros
  // (Morpho's API also reports a meaningless utilization for them).
  const active = markets.filter((m) => m.collateralUsd >= 1);
  const empty = markets.filter((m) => m.collateralUsd < 1);
  const totalCollateral = markets.reduce((s, m) => s + m.collateralUsd, 0);
  // Aave lends one USDC pool against every stock together, so its borrows are counted once, from the pool.
  const totalBorrow = markets.reduce((s, m) => s + (m.borrowUsd ?? 0), 0) + (aaveHub?.borrowUsd ?? 0);
  const countOf = (v: LendingVenue) => markets.filter((m) => m.venue === v).length;
  const biggest = active[0];
  const aaveLif = markets.find((m) => m.venue === 'aave')?.liquidationIncentiveFactor;
  const shareText = risks ? borrowShareText(summarizeBorrow(risks, aaveHub)) : null;
  // USDC a new loan could still draw: Morpho per market; Aave from the one shared pool, within its borrow cap.
  const aaveFree = aaveHub
    ? Math.max(0, Math.min(aaveHub.liquidityUsd, aaveHub.borrowCapUsd != null ? aaveHub.borrowCapUsd - aaveHub.borrowUsd : Infinity))
    : null;

  const calcMarkets: CalculatorMarket[] = markets.map((m) => ({
    marketId: m.marketId,
    symbol: m.symbol,
    venue: venueName[m.venue],
    lltv: m.lltv,
    lif: m.liquidationIncentiveFactor,
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
        Morpho and Aave let you borrow USDC against these stock tokens. If the price falls far enough, a liquidator repays your
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
                <div className="stat-label">
                  Markets on Base: {countOf('morpho')} Morpho, {countOf('aave')} Aave
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <h2>Markets</h2>
            {biggest && (
              <p className="geo-note" style={{ marginTop: 0 }}>
                The biggest is {biggest.symbol} on {venueName[biggest.venue]}: {usdCompact(biggest.collateralUsd)} posted, and
                Aerodrome can absorb {biggest.capacityIsLowerBound ? 'about ' : ''}
                {usdCompact(biggest.profitableLiquidationCapacityUsd)} of it at a profit right now.
              </p>
            )}
            {shareText && (
              <div className="basket-row" style={{ marginTop: 12 }}>
                <ShareButton path="/borrow" card={{ page: 'borrow' }} fileName="afterbook-stock-loans.png" text={shareText} />
              </div>
            )}
            {aaveHub && (
              <p className="geo-note">
                Aave&apos;s stock loans all borrow from one USDC pool: {usdCompact(aaveHub.borrowUsd)} borrowed of{' '}
                {usdCompact(aaveHub.supplyUsd)} ({pct(aaveHub.utilization, 0)} used) at {pct(aaveHub.borrowApr, 2)} a year
                {aaveHub.borrowCapUsd != null && <>, capped at {usdCompact(aaveHub.borrowCapUsd)}</>}. Lenders earn about{' '}
                {pct(aaveHub.supplyApr, 2)} before incentive programs.
              </p>
            )}
            <p className="geo-note">
              &ldquo;Aero exit&rdquo; asks whether Aerodrome could take a market&apos;s whole collateral if every loan in it were
              liquidated at once: Deep (twice over), Tight (just) or Short (not in one go). The amount is the most stock a
              liquidator could sell there right now and still make money, after the price impact and the pool fee. Real
              liquidations are usually much smaller than that worst case, especially on Aave, which sells only enough to make
              a loan healthy again.
            </p>
            <div className="weight-grid">
              {active.map((m) => {
                const stock = getStock(m.symbol);
                const exit = aeroExit(m.collateralUsd, m.profitableLiquidationCapacityUsd);
                const free = m.venue === 'aave' ? aaveFree : m.liquidityUsd;
                return (
                  <div className="weight-card" key={m.marketId}>
                    <div className="weight-card-top">
                      <SymbolTile cashTicker={stock?.cashTicker ?? m.symbol} />
                      <div className="sym-cell-text">
                        <span className="symbol">{m.symbol}</span>
                        <span className="symbol-name">
                          {venueName[m.venue]} · max LTV {pct(m.lltv)}
                        </span>
                      </div>
                    </div>
                    <div className="weight-pct">{pct(m.borrowApy, 2)}</div>
                    <div className="weight-meta" style={{ marginTop: 2 }}>
                      <span>Borrow rate</span>
                      <span>Lenders earn {pct(m.supplyApy, 2)}</span>
                    </div>
                    <div className="weight-meta">
                      <span>Collateral</span>
                      <span>
                        {usdCompact(m.collateralUsd)}
                        {m.collateralCapUsd != null && <> of {usdCompact(m.collateralCapUsd)} cap</>}
                      </span>
                    </div>
                    <div className="weight-meta">
                      <span>Borrowed</span>
                      <span>
                        {m.borrowUsd == null
                          ? 'Shared Aave pool'
                          : `${usdCompact(m.borrowUsd)} (${pct(m.utilization ?? 0, 0)} used)`}
                      </span>
                    </div>
                    <div className="weight-meta">
                      <span>Free to borrow</span>
                      <span>
                        {free == null ? '—' : usdCompact(free)}
                        {m.venue === 'aave' && free != null && ' shared'}
                      </span>
                    </div>
                    <div className="weight-meta">
                      <span>Aero vs oracle</span>
                      <span className={m.aeroVsOracleBp >= 0 ? 'basis-pos' : 'basis-neg'}>{bp(m.aeroVsOracleBp)}</span>
                    </div>
                    <div className="weight-meta">
                      <span>Aero exit</span>
                      <span>
                        <strong style={{ color: 'var(--text)' }}>{exit}</strong>
                        <span>
                          {' · '}
                          {m.capacityIsLowerBound ? '≈ ' : ''}
                          {usdCompact(m.profitableLiquidationCapacityUsd)}
                        </span>
                      </span>
                    </div>
                    <div className="weight-meta">
                      <a className="emph-link" href={`#check=${encodeURIComponent(m.marketId)}`}>
                        Check a loan
                      </a>
                      {m.venue === 'aave' ? (
                        <a className="emph-link" href={m.url} target="_blank" rel="noopener noreferrer">
                          Aave contract ↗
                        </a>
                      ) : (
                        geo.nonUs && (
                          <a className="emph-link" href={m.url} target="_blank" rel="noopener noreferrer">
                            Open on Morpho
                          </a>
                        )
                      )}
                    </div>
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
                      <a className="emph-link" href={m.url} target="_blank" rel="noopener noreferrer">
                        {m.symbol} on {venueName[m.venue]} ({pct(m.lltv)})
                      </a>
                    ) : (
                      `${m.symbol} on ${venueName[m.venue]} (${pct(m.lltv)})`
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
            <section className="panel" id="check">
              <h2>Check a loan</h2>
              <BorrowCalculator markets={calcMarkets} curves={curves} />
            </section>
          )}

          <section className="panel">
            <h2>How this is worked out</h2>
            <ul className="geo-note">
              <li>
                Morpho markets, rates and totals come from Morpho&apos;s public API. Only markets Morpho lists are shown. The
                oracle price, the one liquidations use, is read from each market&apos;s oracle on Base.
              </li>
              <li>
                Aave is read straight from its contracts on Base: the Equities Hub (the shared USDC pool) and the spoke that
                takes the stock tokens, at the addresses in Aave&apos;s own address book. Its rate is the pool&apos;s variable
                rate; incentive programs are not included.
              </li>
              <li>
                A liquidator repaying a loan gets the stock at a bonus set by the market: about{' '}
                {pct(liquidationIncentiveFactor(0.625) - 1, 1)} at a 62.5% max LTV and{' '}
                {pct(liquidationIncentiveFactor(0.77) - 1, 1)} at 77% on Morpho
                {aaveLif != null && (
                  <>
                    , and about {pct(aaveLif - 1, 2)} on Aave (its smallest bonus, when a loan first crosses the line, after
                    Aave&apos;s cut). Aave also liquidates only enough of a loan to make it healthy again, so a real Aave
                    liquidation is usually smaller than the whole loan
                  </>
                )}
                .
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
          Open the Tape<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
