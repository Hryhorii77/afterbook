import type { Metadata } from 'next';
import Link from 'next/link';
import { getTape } from '@/lib/tape';
import { buildTodaySnapshot } from '@/lib/todaySnapshot';
import { bp, usd, usdCompact, formatDuration, formatNextOpen } from '@/lib/format';

// Forces a fresh getTape() read (bounded by its own 20s cache) on every
// request rather than a stale, build-time-frozen number — same reasoning as
// opengraph-image.tsx's own force-dynamic, and this page exists specifically
// to be screenshotted/shared, so a stale number here is worse than on the
// full tape where live client-side polling papers over it.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Today — Afterbook',
  description: "The single biggest cash-vs-chain gap across Base's tokenized stocks right now, and how deep the book behind it is.",
};

export default async function TodayPage() {
  const tape = await getTape().catch(() => null);
  const snapshot = tape ? buildTodaySnapshot(tape) : null;
  const headline = snapshot?.headline ?? null;
  const marketOpen = tape?.session.state === 'open';
  const headlineBp = headline ? (marketOpen ? headline.basisBp : snapshot?.headlineCloseBasisBp ?? headline.basisBp) : null;

  return (
    <main>
      <header className="top">
        <h1>Afterbook · Today</h1>
      </header>

      <section className="panel gap-hero today-hero">
        {!tape || !snapshot ? (
          <p className="geo-note">Tape unavailable right now — try again shortly.</p>
        ) : (
          <>
            <div className="gap-hero-sub">
              {snapshot.sessionLabel}
              {!marketOpen && snapshot.closedForMs > 0 && (
                <>
                  {' '}
                  · closed {formatDuration(snapshot.closedForMs)} ago · reopens {formatNextOpen(snapshot.nextOpenIso)}
                </>
              )}
            </div>

            {headline ? (
              <>
                <div className="today-symbol">
                  Biggest gap: {headline.symbol} · {headline.name}
                </div>
                <div className={`today-stat-value ${headlineBp != null && headlineBp >= 0 ? 'basis-pos' : 'basis-neg'}`}>
                  {bp(headlineBp)}
                </div>
                <div className="gap-detail">
                  <span className="gap-price-pair">
                    <span className="gap-detail-label">cash</span> {usd(marketOpen ? headline.cashLastUsd : headline.closeUsd)}
                  </span>
                  {' → '}
                  <span className="gap-price-pair">
                    <span className="gap-detail-label">aero</span> {usd(headline.onchainMidUsd)}
                  </span>
                </div>
              </>
            ) : (
              <p className="geo-note">No basis reading yet — check back once the tape has real pool data.</p>
            )}
          </>
        )}
      </section>

      {snapshot && (
        <section className="panel">
          <h2>Liquidity behind the tape</h2>
          <p className="geo-note" style={{ marginTop: 0 }}>
            {usdCompact(snapshot.totalLiquidDepthUsd)} in real on-chain depth across {snapshot.liquidCount} liquid{' '}
            {snapshot.liquidCount === 1 ? 'pool' : 'pools'}
            {snapshot.thinCount > 0 &&
              ` (${snapshot.thinCount} thinner ${snapshot.thinCount === 1 ? 'name' : 'names'} not counted here — see the full tape)`}
            .
          </p>
        </section>
      )}

      <p className="geo-note">
        <Link href="/">Open the full tape, size a trade, or check every symbol →</Link>
      </p>
    </main>
  );
}
