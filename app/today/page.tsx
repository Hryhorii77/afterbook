import type { Metadata } from 'next';
import Link from 'next/link';
import { SymbolTile } from '@/app/components/SymbolTile';
import { unstable_cache } from 'next/cache';
import { getTape } from '@/lib/tape';
import { LIQUID_DEPTH_THRESHOLD_USD } from '@/lib/liquidity';
import { buildTodaySnapshot } from '@/lib/todaySnapshot';
import { bp, usd, usdCompact, formatDuration, formatNextOpen } from '@/lib/format';
import { STOCKS, getStock } from '@/lib/tokens';
import { getCachedPoolState, estimateLot, usdcSizeForImpact } from '@/lib/quote';
import { getOpenSnapStats, STATS_LOOKBACK_MS, type OpenSnapStats } from '@/lib/history';

// Forces a fresh getTape() read (bounded by its own 20s cache) on every
// request rather than a stale, build-time-frozen number — same reasoning as
// opengraph-image.tsx's own force-dynamic, and this page exists specifically
// to be screenshotted/shared, so a stale number here is worse than on the
// full tape where live client-side polling papers over it.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Biggest gap — Afterbook',
  description: "The single biggest cash-vs-chain gap across Base's tokenized stocks right now, and how deep the book behind it is.",
};

const CLIP_SIZE_USD = 25_000;

interface SizingInfo {
  clipImpactBp: number;
  clipLargeTradeCaveat: boolean;
  usdFor50bp: number;
  usdFor100bp: number;
}

/** Pool-state-dependent numbers for just the headline symbol — a second RPC
 *  read (cached 20s by lib/quote.ts itself) beyond getTape()'s own, since
 *  TapeRow doesn't carry sqrtPriceX96/liquidity. Never fails the page: a
 *  dropped read here just means this one section doesn't render. */
async function getSizingInfo(symbol: string): Promise<SizingInfo | null> {
  const stock = getStock(symbol);
  if (!stock) return null;
  try {
    const state = await getCachedPoolState(stock);
    const clip = estimateLot(state, stock, CLIP_SIZE_USD);
    return {
      clipImpactBp: clip.impactBp,
      clipLargeTradeCaveat: clip.largeTradeCaveat,
      usdFor50bp: usdcSizeForImpact(state, stock, 50),
      usdFor100bp: usdcSizeForImpact(state, stock, 100),
    };
  } catch {
    return null;
  }
}

interface LeaderboardRow {
  symbol: string;
  stats: OpenSnapStats;
}

/** Same "did the gap mean-revert after 9:30 ET open" stat HomeClient shows
 *  for one symbol at a time — run across all 10 so /today can show which
 *  names actually fade vs which gaps stick, not just today's biggest one. */
async function computeLeaderboard(): Promise<LeaderboardRow[]> {
  const since = Date.now() - STATS_LOOKBACK_MS;
  const results = await Promise.all(
    STOCKS.map(async (stock) => ({ symbol: stock.symbol, stats: await getOpenSnapStats(stock.symbol, since).catch(() => null) })),
  );
  return results
    .filter((r): r is LeaderboardRow => r.stats != null)
    .sort((a, b) => b.stats.revertedPct30 - a.stats.revertedPct30);
}

// The stat is a 30-day window over 5-minute samples, so it barely moves
// between page loads — but computing it pulls thousands of history samples
// per symbol from Redis (~2.5s for all ten), which was the bulk of this
// page's load time. Cached for 10 minutes; the rest of the page stays live.
const getLeaderboard = unstable_cache(computeLeaderboard, ['today-open-snap-leaderboard'], { revalidate: 600 });

export default async function TodayPage() {
  const tape = await getTape().catch(() => null);
  const snapshot = tape ? buildTodaySnapshot(tape) : null;
  const headline = snapshot?.headline ?? null;
  const marketOpen = tape?.session.state === 'open';
  const headlineBp = headline ? (marketOpen ? headline.basisBp : snapshot?.headlineCloseBasisBp ?? headline.basisBp) : null;

  const [sizing, leaderboard] = await Promise.all([
    headline ? getSizingInfo(headline.symbol) : Promise.resolve(null),
    getLeaderboard(),
  ]);

  return (
    <main>
      <header className="top">
        <h1>Biggest gap</h1>
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
                <div className="today-id">
                  <SymbolTile cashTicker={headline.cashTicker} />
                  <div className="sym-cell-text">
                    <span className="today-id-label">Biggest gap right now</span>
                    <span className="symbol">{headline.symbol}</span>
                    <span className="symbol-name" title={headline.name}>{headline.name}</span>
                  </div>
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

                {sizing && (
                  <p className="geo-note" style={{ marginTop: 16 }}>
                    A {usdCompact(CLIP_SIZE_USD)} clip moves the average price {sizing.clipImpactBp.toFixed(1)} bp
                    {sizing.clipLargeTradeCaveat && ' (large enough it may cross into the next tick — rough)'}. Moving the
                    price 50 bp takes about {usdCompact(sizing.usdFor50bp)}; 100 bp takes about {usdCompact(sizing.usdFor100bp)}.
                  </p>
                )}
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
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-value">{usdCompact(snapshot.totalLiquidDepthUsd)}</div>
              <div className="stat-label">Real on-chain depth</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{snapshot.liquidCount}</div>
              <div className="stat-label">Liquid {snapshot.liquidCount === 1 ? 'pool' : 'pools'}</div>
            </div>
            {snapshot.thinCount > 0 && (
              <div className="stat-card">
                <div className="stat-value">{snapshot.thinCount}</div>
                <div className="stat-label">Thinner {snapshot.thinCount === 1 ? 'name' : 'names'}, not counted</div>
              </div>
            )}
          </div>
          <p className="geo-note">
            Depth is what is actually deployed in each pool. Names under {usdCompact(LIQUID_DEPTH_THRESHOLD_USD)} are left
            out of this total; they are on the Tape.
          </p>
        </section>
      )}

      {leaderboard.length > 0 && (
        <section className="panel">
          <h2>Who mean-reverts at the open</h2>
          <p className="geo-note" style={{ marginTop: 0 }}>
            Last {STATS_LOOKBACK_MS / 86_400_000} days: how often each name&apos;s basis moved toward $0 within 30 min of
            the 9:30 ET open, rather than holding or widening. Higher means the overnight gap usually fades fast; lower
            means it tends to stick.
          </p>
          <div className="weight-grid">
            {leaderboard.map((row) => {
              const stock = getStock(row.symbol);
              const p = row.stats.revertedPct30;
              return (
                <div className="weight-card" key={row.symbol}>
                  <div className="weight-card-top">
                    <SymbolTile cashTicker={stock?.cashTicker ?? row.symbol} />
                    <div className="sym-cell-text">
                      <span className="symbol">{row.symbol}</span>
                      <span className="symbol-name" title={stock?.name}>{stock?.name}</span>
                    </div>
                  </div>
                  <div className="weight-pct">{p.toFixed(0)}%</div>
                  <div className="weight-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, p))}%` }} />
                  </div>
                  <div className="weight-meta">
                    <span>{row.stats.days30} sessions</span>
                    <span>{p >= 80 ? 'Usually fades' : p >= 50 ? 'Mixed' : 'Tends to stick'}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <p className="geo-note">
        <Link href="/" className="page-link">
          Open the Tape <span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
