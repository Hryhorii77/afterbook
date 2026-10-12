'use client';

import { BrandMark } from './BrandMark';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletConnectButton } from './WalletConnectButton';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { getStock } from '@/lib/tokens';

// `short` is the label on narrow phones (max-width 420px): five links only fit
// in the phone nav down to 320px if "Biggest gap" reads "Gap" there (owner
// decision, 2026-10-12). Desktop keeps the full label.
const LINKS: { href: string; label: string; short?: string }[] = [
  { href: '/', label: 'Tape' },
  { href: '/today', label: 'Biggest gap', short: 'Gap' },
  { href: '/borrow', label: 'Borrow' },
  { href: '/build', label: 'Build' },
  { href: '/baskets', label: 'Baskets' },
];

export function SiteHeader() {
  const pathname = usePathname();

  // Condense into the floating pill after a short scroll. Different on/off
  // thresholds (32px down, 8px back up) so it doesn't flicker near the edge.
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
  // Symbol pages (/NVDAc etc.) are the tape for one name, so they count as Tape. Any other
  // page that isn't in the nav highlights nothing.
  const active = (href: string) => (href === '/' ? pathname === '/' || getStock(pathname.slice(1)) != null : pathname.startsWith(href));
  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="site-header-inner">
        <Link href="/" className="site-brand" aria-label="Afterbook home">
          <BrandMark size={26} />
          <span className="site-brand-text">Afterbook</span>
        </Link>
        <nav className="site-nav" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined} aria-label={l.short ? l.label : undefined}>
              {l.short ? (
                <>
                  <span className="nav-label-long">{l.label}</span>
                  <span className="nav-label-short" aria-hidden="true">
                    {l.short}
                  </span>
                </>
              ) : (
                l.label
              )}
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
  );
}
