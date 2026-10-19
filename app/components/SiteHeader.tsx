'use client';

import { BrandMark } from './BrandMark';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { WalletConnectButton } from './WalletConnectButton';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './NotificationBell';
import { getStock } from '@/lib/tokens';

// The desktop nav row: the same seven pages as the phone menu (owner, 2026-10-19: Stocks and
// Memestocks joined the nav, replacing the two links under the tape). Phones and tablets (980px and
// narrower) get one header row instead (logo, wallet, bell, theme, menu) and these links in the
// menu panel (the second row of links pushed the hero down about 44px).
const LINKS: { href: string; label: string }[] = [
  { href: '/', label: 'Tape' },
  { href: '/today', label: "Today's gap" },
  { href: '/borrow', label: 'Borrow' },
  { href: '/build', label: 'Build' },
  { href: '/baskets', label: 'Baskets' },
  { href: '/stocks', label: 'Stocks' },
  { href: '/memes', label: 'Memestocks' },
];
const MENU_LINKS: { href: string; label: string; note: string }[] = [
  { href: '/', label: 'Tape', note: 'Every tracked stock: onchain price vs cash price' },
  { href: '/today', label: "Today's gap", note: 'The widest gap right now, in one card' },
  { href: '/borrow', label: 'Borrow', note: 'Loans against stock tokens on Aave and Morpho' },
  { href: '/build', label: 'Build', note: 'Make your own basket of stock tokens' },
  { href: '/baskets', label: 'Baskets', note: 'A managed basket, run on Glider' },
  { href: '/stocks', label: 'Stocks', note: 'All of Coinbase’s tokenized stocks on Base' },
  { href: '/memes', label: 'Memestocks', note: 'Base memes priced in stock tokens' },
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

  // The phone menu: closes on a link, Esc (focus back on the button) and a tap outside.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector('a')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !buttonRef.current?.contains(t)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [menuOpen]);

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
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="site-header-actions">
          <WalletConnectButton />
          <NotificationBell />
          <ThemeToggle />
          <button
            ref={buttonRef}
            type="button"
            className="theme-toggle site-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      <div ref={menuRef} id="site-menu" className="site-menu" hidden={!menuOpen}>
        <nav aria-label="Menu">
          {MENU_LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
              <span className="site-menu-label">{l.label}</span>
              <span className="site-menu-note">{l.note}</span>
            </Link>
          ))}
        </nav>
        <p className="site-menu-foot">Wallet optional: connect one only to see your lots or trade.</p>
      </div>
    </header>
  );
}
