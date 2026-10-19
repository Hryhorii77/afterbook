import type { Metadata } from 'next';
import Link from 'next/link';
import { MemeBoard } from '@/app/components/MemeBoard';
import { getMemeBoard, MEME_MIN_LIQUIDITY_USD } from '@/lib/memestocks';
import { usdCompact } from '@/lib/format';
import { shareMetadata } from '@/lib/shareMeta';

// Live: the allowlist is cached an hour and Dexscreener's numbers two minutes (lib/memestocks.ts),
// so a view costs no chain reads.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = shareMetadata({
  title: 'Memestocks: Base memes traded against stock tokens — Afterbook',
  description: 'Base meme tokens whose pools are quoted in tokenized stocks like NVDAc, with how each meme moves against its stock.',
  path: '/memes',
  card: { page: 'home' },
});

export default async function MemesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [board, sp] = await Promise.all([getMemeBoard(), searchParams]);
  const stock = typeof sp.stock === 'string' ? sp.stock : undefined;
  const checked = board ? new Date(board.checkedAt).toISOString().slice(0, 10) : null;

  return (
    <main>
      <header className="top">
        <h1>Memestocks</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Meme tokens on Base whose pool is priced in a tokenized stock instead of USDC or ETH: BLUECHIP against NVDAc, IPOD against
        AAPLc. Each row shows how the meme moved in the last 24 hours next to its stock.
      </p>
      <p className="meme-warning">
        <strong>Most memecoins go to zero.</strong> The stock token in a meme&apos;s pool does not make the meme safer: it is only
        what the meme is priced in. Afterbook does not pick or recommend any of these; the list is sorted by trading, not by us.
      </p>

      <section className="panel">
        {!board ? (
          <p className="geo-note">The meme list is unavailable right now. Try again shortly.</p>
        ) : board.rows.length === 0 ? (
          <p className="geo-note">No verified meme pools right now.</p>
        ) : (
          <MemeBoard rows={board.rows} initialStock={stock} />
        )}
        <p className="geo-note">
          Listed: pools on Aerodrome and Uniswap where one side is a stock token Afterbook tracks, with at least{' '}
          {usdCompact(MEME_MIN_LIQUIDITY_USD)} of liquidity (smaller ones are under &ldquo;thin&rdquo;). Each pool is checked on the
          chain once a day{checked && <> (last {checked})</>}, and a meme must have a route back to USDC. Prices, volume and moves come
          from Dexscreener and refresh every few minutes. Token names are chosen by whoever launched them.
        </p>
      </section>

      <p className="geo-note">
        <Link href="/stocks" className="page-link">
          Every tokenized stock on Base<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
