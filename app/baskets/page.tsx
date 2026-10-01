import type { Metadata } from 'next';
import Link from 'next/link';
import { getTape } from '@/lib/tape';
import { getGeoInfo } from '@/lib/geo';
import { buildTilt } from '@/lib/baskets/tilt';
import { DEPTH_SHARE, MIN_WEIGHT, MAX_WEIGHT } from '@/lib/baskets/weights';
import { bp, usdCompact } from '@/lib/format';
import { gliderConfigured } from '@/lib/glider';
import { BasketPanel } from '@/app/components/BasketPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Baskets — Afterbook',
  description: 'Afterbook Basis Tilt: the ten Base tokenized stocks, weighted by on-chain depth and cash-vs-chain basis.',
};

export default async function BasketsPage() {
  const [tape, geo] = await Promise.all([getTape().catch(() => null), getGeoInfo()]);
  const tilt = tape ? buildTilt(tape) : null;
  // Only live once both the API key and a strategy id are set — removing
  // either is the off switch.
  const enabled = gliderConfigured() && !!process.env.GLIDER_STRATEGY_ID?.trim();

  return (
    <main>
      <header className="top">
        <h1>Baskets</h1>
      </header>

      <section className="panel">
        <h2>Basis Tilt</h2>
        <p className="geo-note" style={{ marginTop: 0 }}>
          The same ten Base tokenized stocks Afterbook tracks, weighted by what the on-chain books actually show rather
          than equally or by market cap. {Math.round(DEPTH_SHARE * 100)}% of the tilt follows real pool depth; the other{' '}
          {Math.round((1 - DEPTH_SHARE) * 100)}% follows the size of the cash-vs-chain gap, counted only for liquid pools
          since a thin pool&apos;s basis is mostly noise. Every name stays between {MIN_WEIGHT * 100}% and{' '}
          {MAX_WEIGHT * 100}%. Computed from Afterbook&apos;s own on-chain reads — no third-party price feed. The weights below are the live target; the basket itself only updates about once a day, and only when enough of it would change to be worth the trading cost.
        </p>

        {!tilt ? (
          <p className="geo-note">Tape unavailable right now — try again shortly.</p>
        ) : (
          <div className="gap-grid">
            {tilt.map((row) => (
              <div className="gap-cell" key={row.symbol}>
                <div className="gap-symbol">{row.symbol}</div>
                <div>{row.weight}%</div>
                <div className="gap-detail">
                  depth {row.depthUsd != null ? usdCompact(row.depthUsd) : '—'} · basis {bp(row.basisBp)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Enroll</h2>
        {!geo.nonUs ? (
          <button type="button" disabled>Not available in your region</button>
        ) : enabled ? (
          <BasketPanel />
        ) : (
          <button type="button" disabled>Enrollment opens soon</button>
        )}
        <p className={`geo-note${geo.country === 'US' ? ' geo-note-blocked' : ''}`}>
          {geo.country === 'US'
            ? 'Not available in the US.'
            : geo.country
              ? `Detected region: ${geo.country}.`
              : 'Region could not be detected.'}{' '}
          This is a best-effort check based on IP country, not a compliance control — it does not stop a VPN. Afterbook
          never holds funds or executes trades for baskets.
        </p>
      </section>

      <p className="geo-note">
        <Link href="/" className="page-link">
          Open the full tape <span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
