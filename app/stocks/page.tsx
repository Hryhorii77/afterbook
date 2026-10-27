import type { Metadata } from 'next';
import Link from 'next/link';
import { StockDirectory } from '@/app/components/StockDirectory';
import { getStockDirectory } from '@/lib/stockDirectory';
import { getTape } from '@/lib/tape';
import { LIQUID_DEPTH_THRESHOLD_USD } from '@/lib/liquidity';
import { usdCompact } from '@/lib/format';
import { shareMetadata } from '@/lib/shareMeta';

// Rendered per request (the tape's live depth for tracked rows, cached 20 s underneath). Coinbase's
// list and the daily pool snapshot are each cached an hour, so a page view costs no chain reads for
// untracked tokens and at most one Redis request an hour.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = shareMetadata({
  title: 'Every tokenized stock on Base — Afterbook',
  description:
    "Every tokenized stock Coinbase issues on Base, with its contract and how deep its onchain pool is. Afterbook tracks the ones deep enough for a real price gap.",
  path: '/stocks',
  card: { page: 'home' },
});

/** The depth an untracked pool needs before it is worth adding (the discovery job's snippet line). */
const ADD_AT_USD = 250_000;

export default async function StocksPage() {
  const tape = await getTape().catch(() => null);
  const trackedDepth = Object.fromEntries((tape?.rows ?? []).map((r) => [r.symbol, r.depthUsd]));
  const dir = await getStockDirectory(trackedDepth);
  const tracked = dir?.rows.filter((r) => r.status === 'tracked').length ?? 0;
  const deepestOther = dir?.rows.find((r) => r.status === 'pool' && r.depthUsd != null);
  const checked = dir?.checkedAt ? new Date(dir.checkedAt).toISOString().slice(0, 10) : null;

  return (
    <main>
      <header className="top">
        <h1>Every tokenized stock on Base</h1>
      </header>
      {!dir ? (
        <section className="panel">
          <p className="geo-note">Coinbase&apos;s list of tokenized stocks is unavailable right now. Try again shortly.</p>
        </section>
      ) : (
        <>
          <p className="geo-note" style={{ marginTop: 0 }}>
            Coinbase issues {dir.rows.length} tokenized stocks on Base. Afterbook tracks the {tracked} with a USDC pool on Aero
            deep enough for the gap to the stock market to mean something
            {deepestOther?.depthUsd != null && (
              <>
                ; the deepest of the rest holds {usdCompact(deepestOther.depthUsd)} ({deepestOther.symbol})
              </>
            )}
            . In pools that small one ordinary trade moves the price, so the &ldquo;gap&rdquo; would be noise; a stock joins the
            tape once its pool passes about {usdCompact(ADD_AT_USD)}.
          </p>
          <section className="panel">
            <StockDirectory rows={dir.rows} />
            <p className="geo-note">
              Depth is the real value held in the stock&apos;s USDC pool (Aero or Aerodrome): live for tracked stocks (under{' '}
              {usdCompact(LIQUID_DEPTH_THRESHOLD_USD)} shows as a thin book on the tape), checked once a day for the rest
              {checked && <> (last {checked})</>}. Price, 24h move and volume are from each token&apos;s deepest pool on Base (any
              exchange, via Dexscreener, refreshed every few minutes); &ldquo;On Base&rdquo; is that price times the tokens in
              circulation on Base, not the company&apos;s market cap. Memes are the verified ones on{' '}
              <Link href="/memes" className="emph-link">
                Memestocks
              </Link>
              . Coinbase&apos;s stock tokens are not available to people in the United States.
            </p>
          </section>
        </>
      )}

      <p className="geo-note">
        <Link href="/memes" className="page-link">
          Memes traded against these stocks<span className="arrow">→</span>
        </Link>
      </p>
      <p className="geo-note">
        <Link href="/" className="page-link">
          Open the Tape<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
