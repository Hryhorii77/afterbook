'use client';

import { useEffect, useState } from 'react';
import type { TapeRow } from '@/lib/tape';
import { bp, usd } from '@/lib/format';
import { SymbolTile } from './SymbolTile';

const POLL_MS = 30_000;

// Slow marquee of every tracked name: on-chain price and the live basis.
// Reads the same cached /api/tape the page uses. The strip reserves its height
// before data arrives, so nothing shifts when it fills in.
export function TickerStrip() {
  const [rows, setRows] = useState<TapeRow[] | null>(null);

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
  const renderItems = (hidden: boolean) =>
    items.map((r) => {
      const up = (r.basisBp ?? 0) >= 0;
      return (
        <span className="ticker-item" key={(hidden ? 'b-' : 'a-') + r.symbol} aria-hidden={hidden || undefined}>
          <SymbolTile cashTicker={r.cashTicker} size="sm" />
          <span className="ticker-price">{usd(r.onchainMidUsd)}</span>
          {r.basisBp != null && (
            <span className={`ticker-change ${up ? 'basis-pos' : 'basis-neg'}`}>
              {up ? '▲' : '▼'} {bp(Math.abs(r.basisBp)).replace('+', '')}
            </span>
          )}
        </span>
      );
    });

  return (
    <div className="ticker" aria-label="Live prices">
      {items.length > 0 && (
        <div className="ticker-track">
          {renderItems(false)}
          {renderItems(true)}
        </div>
      )}
    </div>
  );
}
