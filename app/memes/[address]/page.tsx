import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SymbolTile } from '@/app/components/SymbolTile';
import { ShareButton } from '@/app/components/ShareButton';
import { MemeBuySection } from '@/app/components/MemeBuySection';
import { getGeoInfo } from '@/lib/geo';
import { getMemeRow, MEME_MIN_LIQUIDITY_USD, poolUrl, venueLabel, type MemeRow } from '@/lib/memestocks';
import { usdCompact } from '@/lib/format';
import { ageText, memePrice, moveSentence, pctMove, usdOrDash } from '@/lib/memeFormat';
import { getStock } from '@/lib/tokens';
import { shareMetadata } from '@/lib/shareMeta';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ address: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const { address } = await params;
  const row = await getMemeRow(address);
  if (!row) return { title: 'Meme not listed — Afterbook' };
  const m = row.pool.meme;
  return shareMetadata({
    title: `${m.symbol} on ${row.pool.stockSymbol} — Afterbook memestocks`,
    description: moveSentence(m.symbol, row.move.h24, row.pool.stockSymbol, row.stockMove.h24) ?? `${m.symbol}, a Base meme priced in ${row.pool.stockSymbol}.`,
    path: `/memes/${m.address}`,
    card: { page: 'meme', addr: m.address },
    searchParams: await searchParams,
  });
}

const moveClass = (n: number | null) => (n == null ? '' : n >= 0 ? 'meme-up' : 'meme-down');

function verificationText(row: MemeRow): string {
  const v = row.pool.venue;
  if (v !== 'uniswap-v4') return `Checked on the chain: ${venueLabel(v)}'s factory lists this pool for exactly these two tokens.`;
  return row.pool.verification === 'proven'
    ? "Checked on the chain: Uniswap's PositionManager holds this pool's key, and the key hashes to this pool id."
    : "Checked on the chain: the pool exists in Uniswap v4 with liquidity, and its price matches this pair. Its key could not be read directly (it was created outside Uniswap's PositionManager).";
}

export default async function MemePage({ params }: Params) {
  const { address } = await params;
  const [row, geo] = await Promise.all([getMemeRow(address), getGeoInfo()]);
  if (!row) notFound();
  const { meme, stockSymbol } = row.pool;
  const stock = getStock(stockSymbol);
  const sentence = moveSentence(meme.symbol, row.move.h24, stockSymbol, row.stockMove.h24);

  return (
    <main>
      <header className="top">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SymbolTile cashTicker={meme.symbol.slice(0, 5)} iconUrl={row.imageUrl} />
          {meme.symbol} <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>on {stockSymbol}</span>
        </h1>
      </header>
      {meme.name && meme.name !== meme.symbol && (
        <p className="geo-note" style={{ marginTop: 0 }}>
          &ldquo;{meme.name}&rdquo;, a meme token on Base priced in {stock?.name ?? stockSymbol}&apos;s stock token. The name is the
          launcher&apos;s, not the company&apos;s: it has nothing to do with {stock?.name ?? stockSymbol}.
        </p>
      )}
      <p className="meme-warning">
        <strong>Most memecoins go to zero.</strong> The {stockSymbol} in this pool does not make {meme.symbol} safer: it is only what{' '}
        {meme.symbol} is priced in. If {meme.symbol} falls, you lose that money whatever {stockSymbol} does. Afterbook does not recommend it.
      </p>

      <section className="panel">
        {sentence && <p className="meme-headline">{sentence}</p>}
        <table className="meme-move-table">
          <thead>
            <tr>
              <th>Move</th>
              <th>1 hour</th>
              <th>6 hours</th>
              <th>24 hours</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{meme.symbol}</td>
              {(['h1', 'h6', 'h24'] as const).map((k) => (
                <td key={k} className={moveClass(row.move[k])}>{pctMove(row.move[k])}</td>
              ))}
            </tr>
            <tr>
              <td>{stockSymbol}</td>
              {(['h1', 'h6', 'h24'] as const).map((k) => (
                <td key={k} className={moveClass(row.stockMove[k])}>{pctMove(row.stockMove[k])}</td>
              ))}
            </tr>
          </tbody>
        </table>
        <div className="stat-grid meme-stat-grid">
          <div className="stat-card">
            <div className="stat-value">{memePrice(row.priceUsd)}</div>
            <div className="stat-label">Price</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{usdOrDash(row.volume24Usd)}</div>
            <div className="stat-label">Traded in 24h</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{usdOrDash(row.liquidityUsd)}</div>
            <div className="stat-label">Pool liquidity{row.thin ? ' (thin)' : ''}</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{usdOrDash(row.stockInPoolUsd)}</div>
            <div className="stat-label">
              {stockSymbol} in the pool{row.stockInPool != null && ` (${row.stockInPool.toLocaleString('en-US', { maximumFractionDigits: 2 })})`}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{usdOrDash(row.marketCapUsd)}</div>
            <div className="stat-label">Market cap</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{ageText(row.pool.createdAt)}</div>
            <div className="stat-label">Pool age</div>
          </div>
        </div>
        {sentence && (
          <div className="basket-row" style={{ marginTop: 16 }}>
            <ShareButton path={`/memes/${meme.address}`} card={{ page: 'meme', addr: meme.address }} fileName={`afterbook-${meme.symbol.toLowerCase()}.png`} text={`${sentence}. Base memes priced in stock tokens, on Afterbook:`} />
          </div>
        )}
      </section>

      <section className="panel" id="buy">
        <h2>Buy {meme.symbol}</h2>
        {row.thin || !stock ? (
          <p className="geo-note" style={{ marginTop: 0 }}>
            Buying here is off: this pool holds under {usdCompact(MEME_MIN_LIQUIDITY_USD)} of liquidity, so a small trade moves the price a lot.
          </p>
        ) : (
          <MemeBuySection meme={{ address: meme.address, symbol: meme.symbol, decimals: meme.decimals }} stock={stock} geo={geo} />
        )}
      </section>

      <section className="panel">
        <h2>The pool</h2>
        <ul className="geo-note" style={{ paddingLeft: 18 }}>
          <li>
            {venueLabel(row.pool.venue)} pool {meme.symbol}/{stockSymbol}:{' '}
            <a href={poolUrl(row.pool)} target="_blank" rel="noopener noreferrer" className="emph-link">
              {row.pool.id.slice(0, 8)}…{row.pool.id.slice(-6)} on Dexscreener&nbsp;↗
            </a>
          </li>
          <li>
            {meme.symbol} contract:{' '}
            <a href={`https://basescan.org/token/${meme.address}`} target="_blank" rel="noopener noreferrer" className="emph-link">
              {meme.address.slice(0, 6)}…{meme.address.slice(-4)} on BaseScan&nbsp;↗
            </a>{' '}
            (other tokens may use the same name; this address is the one listed here)
          </li>
          <li>{verificationText(row)}</li>
          {row.pool.hooks && (
            <li>
              This pool runs a Uniswap v4 hook ({row.pool.hooks.slice(0, 6)}…{row.pool.hooks.slice(-4)}), a contract that can change fees
              or trading rules for this pool.
            </li>
          )}
          <li>Prices, volume and moves are Dexscreener&apos;s and refresh every few minutes.</li>
        </ul>
      </section>

      <p className="geo-note">
        <Link href="/memes" className="page-link">
          All memestocks<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
