'use client';

import { BrandMark } from './BrandMark';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletConnectButton } from './WalletConnectButton';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from '../notifications/NotificationBell';
import { getStock } from '@/lib/stocks/tokens';

// Five tabs (owner, 2026-11-03, from an external review): Trade is the home page; Markets holds the
// tape, today's gap, every stock and each stock's page; Borrow the loan markets; Portfolio the
// wallet's positions; More everything else. Desktop shows them in the header; 900px and narrower
// shows the same five in a bar fixed to the bottom of the screen (it replaced the menu panel).
type Tab = { href: string; label: string; icon: React.ReactNode; also?: (path: string) => boolean };

const icon = (d: string) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const TABS: Tab[] = [
  { href: '/', label: 'Trade', icon: icon('M7 10h13l-4-4M17 14H4l4 4') },
  {
    href: '/markets',
    label: 'Markets',
    icon: icon('M4 19V5M4 19h16M8 15l3-4 3 2 5-6'),
    // A stock's own page (/NVDAc), today's gap and the stock list are all market views.
    also: (p) => p.startsWith('/today') || p.startsWith('/stocks') || getStock(p.slice(1)) != null,
  },
  { href: '/borrow', label: 'Borrow', icon: icon('M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.6 5 3 5 1.3 5 3.2-2.2 3-5 3-5-1.1-5-3') },
  { href: '/portfolio', label: 'Portfolio', icon: icon('M4 7h16v12H4zM8 7V5h8v2M4 12h16') },
  {
    href: '/more',
    label: 'More',
    icon: icon('M5 12h.01M12 12h.01M19 12h.01'),
    also: (p) => p.startsWith('/baskets') || p.startsWith('/build') || p.startsWith('/memes'),
  },
];

function isActive(tab: Tab, path: string): boolean {
  if (tab.href === '/') return path === '/';
  return path.startsWith(tab.href) || (tab.also?.(path) ?? false);
}

export function SiteHeader() {
  const pathname = usePathname() ?? '/';

  // Condense into the floating pill after a short scroll (desktop). Different on/off thresholds
  // (32px down, 8px back up) so it doesn't flicker near the edge.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setScrolled((was) => (was ? window.scrollY > 8 : window.scrollY > 32)));
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => {
      window.removeEventListener('scroll', update);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <header className="site-header" data-scrolled={scrolled}>
        <div className="site-header-inner">
          <Link href="/" className="site-brand" aria-label="Afterbook home">
            <BrandMark size={26} />
            <span className="site-brand-text">Afterbook</span>
          </Link>
          <nav className="site-nav" aria-label="Main">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} aria-current={isActive(t, pathname) ? 'page' : undefined}>
                {t.label}
              </Link>
            ))}
          </nav>
          <div className="site-header-actions">
            <WalletConnectButton />
            <NotificationBell />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <nav className="tab-bar" aria-label="Main">
        {TABS.map((t) => (
          <Link key={t.href} href={t.href} aria-current={isActive(t, pathname) ? 'page' : undefined}>
            {t.icon}
            <span>{t.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
