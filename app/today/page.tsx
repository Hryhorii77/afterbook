import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { SymbolTile } from '@/app/components/ui/SymbolTile';
import { SessionPill } from '@/app/components/ui/SessionPill';
import { ShareButton } from '@/app/components/ui/ShareButton';
import { unstable_cache } from 'next/cache';
import { getTape } from '@/lib/market/tape';
import { LIQUID_DEPTH_THRESHOLD_USD } from '@/lib/market/liquidity';
import { buildTodaySnapshot, todayReference } from '@/lib/market/todaySnapshot';
import { bp, bpPct, usd, usdCompact, formatDuration, formatNextOpen, gapVsText, bpClass } from '@/lib/format';
import { getStock } from '@/lib/stocks/tokens';
import { getBuyQuoter } from '@/lib/market/lotQuote';
import { STATS_LOOKBACK_MS } from '@/lib/market/history';
import { computeOpenLeaderboard, readOpenLeaderboard, type LeaderboardRow } from '@/lib/market/openLeaderboard';
import { shareMetadata } from '@/lib/share/shareMeta';
import { firstParam } from '@/lib/share/cardUrl';
import { todayShareText } from '@/lib/share/shareText';

// Forces a fresh getTape() read (bounded by its own 20s cache) on every
// request rather than a stale, build-time-frozen number — same reasoning as
// the share card route's own force-dynamic (app/card/route.tsx), and this page exists specifically
// to be screenshotted/shared, so a stale number here is worse than on the
// full tape where live client-side polling papers over it.
export const dynamic = 'force-dynamic';

// A shared link carries the stock the page showed (`sym`), so its card shows that stock and not
// whichever one leads a second later (lib/share/cardUrl.ts).
export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const sp = await searchParams;
  const sym = getStock(firstParam(sp.sym) ?? '')?.symbol;
  return shareMetadata({
    title: "Today's gap — Afterbook",
    description: "The single biggest cash-vs-chain gap across Base's tokenized stocks right now, and how deep the book behind it is.",
    path: '/today',
    card: { page: 'today', sym },
    searchParams: sp,
  });
}

const CLIP_SIZE_USD = 25_000;

interface SizingInfo {
  clipImpactBp: number;
  clipLargeTradeCaveat: boolean;
  usdFor50bp: number;
  usdFor100bp: number;
}

/** Pool-state-dependent numbers for just the headline symbol — a second RPC
 *  read (cached 20s by lib/market/quote.ts itself) beyond getTape()'s own, since
 *  TapeRow doesn't carry sqrtPriceX96/liquidity. Never fails the page: a
 *  dropped read here just means this one section doesn't render. */
async function getSizingInfo(symbol: string): Promise<SizingInfo | null> {
  const stock = getStock(symbol);
  if (!stock) return null;
  try {
    const quoter = await getBuyQuoter(stock);
    const clip = quoter.estimate(CLIP_SIZE_USD);
    return {
      clipImpactBp: clip.impactBp,
      clipLargeTradeCaveat: clip.largeTradeCaveat,
      usdFor50bp: quoter.sizeForImpact(50),
      usdFor100bp: quoter.sizeForImpact(100),
    };
  } catch {
    return null;
  }
}

// The leaderboard (lib/market/openLeaderboard.ts) is computed once a day by the discover-tokens cron and saved as one
// key; this reads it through the data cache for 10 minutes. Without a saved one (its first day, or failed runs) the
// page computes it itself, which reads 30 days of history for every stock (~14 s cold for 39), streamed (Suspense
// below) so the rest of the page never waits.
const getLeaderboard = unstable_cache(
  async (): Promise<LeaderboardRow[]> => (await readOpenLeaderboard()) ?? computeOpenLeaderboard(),
  ['today-open-snap-leaderboard-v2'],
  { revalidate: 600 },
);

/** "Who mean-reverts at the open": its own server component so the page can stream it (the Suspense in TodayPage). */
async function Leaderboard() {
  const leaderboard = await getLeaderboard().catch(() => [] as LeaderboardRow[]);
  if (leaderboard.length === 0) return null;
  return (
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
  );
}

export default async function TodayPage() {
  const tape = await getTape().catch(() => null);
  const snapshot = tape ? buildTodaySnapshot(tape) : null;
  const headline = snapshot?.headline ?? null;
  const marketOpen = tape?.session.state === 'open';
  // One rule with the home page's hero (todayReference): live cash, a live extended-hours trade, or the close.
  const ref = headline && tape ? todayReference(headline, tape.session) : null;
  const headlineBp = ref?.bp ?? null;

  const sizing = headline ? await getSizingInfo(headline.symbol) : null;

  return (
    <main>
      <header className="top">
        <h1>Today&apos;s gap</h1>
      </header>

      <section className="panel gap-hero today-hero">
        {!tape || !snapshot ? (
          <p className="geo-note">Tape unavailable right now — try again shortly.</p>
        ) : (
          <>
            {headline ? (
              <>
                <div className="today-top">
                  <div className="today-id">
                    <SymbolTile cashTicker={headline.cashTicker} />
                    <div className="sym-cell-text">
                      <span className="today-id-label">Biggest gap right now</span>
                      <span className="symbol">{headline.symbol}</span>
                      <span className="symbol-name" title={headline.name}>{headline.name}</span>
                    </div>
                  </div>
                  {tape && <SessionPill state={tape.session.state} label={tape.session.label} nyTime={tape.session.nyTime} />}
                </div>

                {!marketOpen && snapshot.closedForMs > 0 && (
                  <p className="geo-note" style={{ marginTop: 12, marginBottom: 0 }}>
                    Closed {formatDuration(snapshot.closedForMs)} ago · reopens {formatNextOpen(snapshot.nextOpenIso)}
                  </p>
                )}

                <div className="today-stats">
                  <div className="stat-card stat-card-hero">
                    <div className="stat-label" style={{ marginTop: 0 }}>Onchain price vs cash price</div>
                    <div className={`today-stat-value ${bpClass(headlineBp)}`}>
                      {bpPct(headlineBp)}
                      {headlineBp != null && <span className="today-stat-bp">{bp(headlineBp)}</span>}
                    </div>
                    {headlineBp != null && (
                      <div className="hero-sentence">
                        {`On Base, ${headline.symbol} is trading ${gapVsText(headlineBp)} the cash ${ref?.word ?? 'close'}.`}
                      </div>
                    )}
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{usd(ref?.cashUsd ?? null)}</div>
                    <div className="stat-label">{ref?.cardLabel ?? 'Cash close'}</div>
                  </div>
                  <div className="stat-card stat-card-onchain">
                    <div className="stat-value">{usd(headline.onchainMidUsd)}</div>
                    <div className="stat-label">Onchain price</div>
                    {headline.depthUsd != null && <div className="stat-sub">Pool liquidity {usdCompact(headline.depthUsd)}</div>}
                  </div>
                </div>

                {headlineBp != null && (
                  <div className="hero-actions">
                    <Link href={`/${headline.symbol}#execute`} className="btn">
                      Trade {headline.symbol}
                    </Link>
                    <ShareButton
                      path="/today"
                      card={{ page: 'today', sym: headline.symbol }}
                      fileName={`afterbook-biggest-gap-${headline.symbol}.png`}
                      text={todayShareText(headline.symbol, headlineBp, ref?.word ?? 'close')}
                    />
                  </div>
                )}

                {sizing && (
                  <>
                    <div className="today-id-label" style={{ marginTop: 20 }}>What it takes to trade it</div>
                    <div className="stat-grid" style={{ marginTop: 8 }}>
                      <div className="stat-card">
                        <div className="stat-value">{sizing.clipLargeTradeCaveat ? '≥ ' : ''}{sizing.clipImpactBp.toFixed(1)} bp</div>
                        <div className="stat-label">Price impact of a {usdCompact(CLIP_SIZE_USD)} clip</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-value">{usdCompact(sizing.usdFor50bp)}</div>
                        <div className="stat-label">To move the price 50 bp</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-value">{usdCompact(sizing.usdFor100bp)}</div>
                        <div className="stat-label">To move the price 100 bp</div>
                      </div>
                    </div>
                    {sizing.clipLargeTradeCaveat && (
                      <p className="geo-note">The clip runs past the liquidity Afterbook reads (25% from the price), so the real cost would be higher.</p>
                    )}
                  </>
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

      {/* Streamed (2026-11-25): computed cold it reads 30 days of history for every stock (~14 s after a deploy, when
          its 10-minute cache is empty), and the whole page used to wait for it; once it held /today for 35 s live. Now
          the page renders at once and this section arrives when ready (instantly while cached). */}
      <Suspense
        fallback={
          <section className="panel" aria-busy="true">
            <h2>Who mean-reverts at the open</h2>
            <p className="geo-note" style={{ marginTop: 0 }}>
              Working out the last {STATS_LOOKBACK_MS / 86_400_000} days…
            </p>
          </section>
        }
      >
        <Leaderboard />
      </Suspense>

      <p className="geo-note">
        <Link href="/build" className="page-link">
          Build a basket of 2 to 4 stocks<span className="arrow">→</span>
        </Link>
      </p>
      <p className="geo-note">
        <Link href="/markets" className="page-link">
          Open the Tape<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
