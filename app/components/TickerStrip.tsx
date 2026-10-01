'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { TapeRow } from '@/lib/tape';
import { bp, usd } from '@/lib/format';
import { SymbolTile } from './SymbolTile';

const POLL_MS = 30_000;

// Slow marquee of every tracked name: on-chain price and the live basis.
// Reads the same cached /api/tape the page uses. The strip reserves its height
// before data arrives, so nothing shifts when it fills in.
export function TickerStrip() {
  const [rows, setRows] = useState<TapeRow[] | null>(null);
  // After a click the strip must run again even if the pointer is still over it
  // (until the pointer leaves), so a tap never leaves it frozen.
  const [resumed, setResumed] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let off = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch('/api/tape', { cache: 'no-store' });
        if (!res.ok) return;
        const tape = (await res.json()) as { rows?: TapeRow[] };
        if (!off && Array.isArray(tape.rows)) setRows(tape.rows);
      } catch {
        // Keep showing the last good reading.
      }
    };
    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, []);

  const items = (rows ?? []).filter((r) => r.onchainMidUsd != null);
  // Each item opens that stock's page. The second copy (which makes the marquee
  // loop seamlessly) is hidden from assistive tech and the tab order, so
  // keyboard users meet each stock once.
  const renderItems = (hidden: boolean) =>
    items.map((r) => {
      const up = (r.basisBp ?? 0) >= 0;
      const here = pathname.toLowerCase() === `/${r.symbol}`.toLowerCase();
      return (
        <Link
          href={`/${r.symbol}`}
          prefetch={false}
          className={`ticker-item${here ? ' ticker-item-here' : ''}`}
          key={(hidden ? 'b-' : 'a-') + r.symbol}
          aria-hidden={hidden || undefined}
          tabIndex={hidden ? -1 : undefined}
          aria-current={here && !hidden ? 'page' : undefined}
          onClick={(e) => {
            setResumed(true);
            // A clicked link keeps keyboard focus; release it so nothing stays "active".
            e.currentTarget.blur();
          }}
          aria-label={hidden ? undefined : `${r.symbol}, ${usd(r.onchainMidUsd)}, open stock page`}
        >
          <SymbolTile cashTicker={r.cashTicker} size="sm" />
          <span className="ticker-price">{usd(r.onchainMidUsd)}</span>
          {r.basisBp != null && (
            <span className={`ticker-change ${up ? 'basis-pos' : 'basis-neg'}`}>
              {up ? '▲' : '▼'} {bp(Math.abs(r.basisBp)).replace('+', '')}
            </span>
          )}
        </Link>
      );
    });

  return (
    <div className={`ticker${resumed ? ' ticker-resumed' : ''}`} aria-label="Live prices" onMouseLeave={() => setResumed(false)}>
      {items.length > 0 && (
        <div className="ticker-track">
          {renderItems(false)}
          {renderItems(true)}
        </div>
      )}
    </div>
  );
}
