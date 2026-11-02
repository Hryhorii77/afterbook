import Link from 'next/link';
import { shareMetadata } from '@/lib/shareMeta';

export const metadata = shareMetadata({
  title: 'More — Afterbook',
  description: 'Baskets, memestocks, Telegram alerts, how Afterbook works and its public API.',
  path: '/more',
  card: { page: 'home' },
});

const README = 'https://github.com/Hryhorii77/afterbook#readme';

// Everything that isn't one of the four main tabs (owner, 2026-11-03).
const GROUPS: { title: string; items: { href: string; label: string; note: string; external?: boolean }[] }[] = [
  {
    title: 'Invest',
    items: [
      { href: '/baskets', label: 'Baskets', note: 'A managed basket of stock tokens, run on Glider' },
      { href: '/build', label: 'Build a basket', note: 'Pick your own stocks and weights, buy them in one go' },
      { href: '/memes', label: 'Memestocks', note: 'Base memes priced in stock tokens. Any memecoin can go to zero.' },
    ],
  },
  {
    title: 'Markets',
    items: [
      { href: '/today', label: "Today's gap", note: 'The widest gap right now, in one card' },
      { href: '/stocks', label: 'Every tokenized stock', note: 'All of Coinbase’s stock tokens on Base, tracked or not' },
    ],
  },
  {
    title: 'Learn and connect',
    items: [
      { href: 'https://t.me/afterbook_bot', label: 'Telegram alerts', note: 'A message when a gap crosses your level, or a loan gets close to liquidation', external: true },
      { href: README, label: 'How it works', note: 'Where every number comes from, and the checks on each trade', external: true },
      { href: 'https://github.com/Hryhorii77/afterbook#public-api', label: 'API and MCP', note: 'The same data for your own scripts and agents', external: true },
    ],
  },
];

export default function MorePage() {
  return (
    <main>
      <header className="top">
        <h1>More</h1>
      </header>
      {GROUPS.map((g) => (
        <section className="panel" key={g.title}>
          <h2>{g.title}</h2>
          <ul className="more-list">
            {g.items.map((i) => (
              <li key={i.href}>
                {i.external ? (
                  <a href={i.href} target="_blank" rel="noopener noreferrer">
                    <span className="more-label">
                      {i.label}&nbsp;<span className="ext-arrow">↗</span>
                    </span>
                    <span className="more-note">{i.note}</span>
                  </a>
                ) : (
                  <Link href={i.href}>
                    <span className="more-label">{i.label}</span>
                    <span className="more-note">{i.note}</span>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
