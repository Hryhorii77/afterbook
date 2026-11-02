import Link from 'next/link';
import { MyLots } from '../components/MyLots';
import { shareMetadata } from '@/lib/shareMeta';

export const metadata = shareMetadata({
  title: 'Portfolio — Afterbook',
  description: 'Your stock tokens and pool positions on Base, valued at the live price. Read-only: connecting a wallet only shares its address.',
  path: '/portfolio',
  card: { page: 'home' },
});

// The wallet's positions (My Lots until 2026-11-03, when it moved here from the tape page).
export default function PortfolioPage() {
  return (
    <main>
      <header className="top">
        <h1>Portfolio</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        The stock tokens and pool positions a wallet holds on Base, at today&apos;s price. Reading them needs no signature.
      </p>
      <MyLots title="Your positions" />
      <div className="basket-row">
        <Link href="/markets" className="page-link">
          See every stock<span className="arrow">→</span>
        </Link>
      </div>
    </main>
  );
}
