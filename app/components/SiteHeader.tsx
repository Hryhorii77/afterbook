'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletConnectButton } from './WalletConnectButton';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';

const LINKS = [
  { href: '/', label: 'Tape' },
  { href: '/today', label: 'Biggest gap' },
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
  // Symbol pages (/NVDAc etc.) are the tape for one name, so they count as Tape.
  const active = (href: string) => (href === '/' ? !LINKS.slice(1).some((l) => pathname.startsWith(l.href)) : pathname.startsWith(href));
  return (
    <header className="site-header" data-scrolled={scrolled}>
      <div className="site-header-inner">
        <Link href="/" className="site-brand" aria-label="Afterbook home">
          <span className="site-brand-mark" aria-hidden="true" />
          <span className="site-brand-text">Afterbook</span>
        </Link>
        <nav className="site-nav" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined}>
              {l.label}
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
