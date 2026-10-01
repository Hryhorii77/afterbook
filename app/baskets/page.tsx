import type { Metadata } from 'next';
import Link from 'next/link';
import { getTape } from '@/lib/tape';
import { getGeoInfo } from '@/lib/geo';
import { buildTilt } from '@/lib/baskets/tilt';
import { DEPTH_SHARE, MIN_WEIGHT, MAX_WEIGHT } from '@/lib/baskets/weights';
import { bp, usdCompact } from '@/lib/format';
import { getStock } from '@/lib/tokens';
import { SymbolTile } from '@/app/components/SymbolTile';
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
          <div className="weight-grid">
            {tilt.map((row) => {
              const stock = getStock(row.symbol);
              return (
                <div className="weight-card" key={row.symbol}>
                  <div className="weight-card-top">
                    <SymbolTile cashTicker={stock?.cashTicker ?? row.symbol} />
                    <div className="sym-cell-text">
                      <span className="symbol">{row.symbol}</span>
                      <span className="symbol-name" title={stock?.name}>{stock?.name}</span>
                    </div>
                  </div>
                  <div className="weight-pct">{row.weight}%</div>
                  <div className="weight-bar" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, (Number(row.weight) / (MAX_WEIGHT * 100)) * 100)}%` }} />
                  </div>
                  <div className="weight-meta">
                    <span>Depth {row.depthUsd != null ? usdCompact(row.depthUsd) : '—'}</span>
                    <span className={row.basisBp != null ? (row.basisBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}>{bp(row.basisBp)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>How it works</h2>
        <ol className="how-grid">
          <li className="how-step">
            <span className="how-num">01</span>
            <h3>Connect and sign</h3>
            <p>Connect your wallet and sign one message. That creates your own account on Base. No funds move.</p>
          </li>
          <li className="how-step">
            <span className="how-num">02</span>
            <h3>Deposit USDC</h3>
            <p>Send USDC from your wallet to that account. It stays yours; Afterbook never holds it.</p>
          </li>
          <li className="how-step">
            <span className="how-num">03</span>
            <h3>Glider buys the basket</h3>
            <p>
              Glider spreads your deposit across the ten stocks at the target weights. It rebalances about once a day,
              and only when the weights have moved enough to be worth the trading cost.
            </p>
          </li>
          <li className="how-step">
            <span className="how-num">04</span>
            <h3>Withdraw any time</h3>
            <p>Sign again to take everything out, as USDC or as the tokens themselves.</p>
          </li>
        </ol>
      </section>

      <section className="panel">
        <h2>Enroll</h2>
        <p className="geo-note" style={{ marginTop: 0 }}>
          Real money, and you can lose it.{' '}
          <Link href="/baskets/risks" className="emph-link">Read the risks and terms</Link> first.
        </p>
        <p className="geo-note">
          Trading and accounts run on{' '}
          <a href="https://glider.fi" target="_blank" rel="noopener noreferrer" className="emph-link">
            Glider ↗
          </a>
          . Afterbook sets the target weights and charges no fee.
        </p>
        {!geo.nonUs ? (
          <button type="button" className="btn" disabled>Not available in your region</button>
        ) : enabled ? (
          <BasketPanel />
        ) : (
          <button type="button" className="btn" disabled>Enrollment opens soon</button>
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
          Open the Tape <span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
