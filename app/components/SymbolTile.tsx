import type { CSSProperties } from 'react';
import { tileHue } from '@/lib/symbolStyle';

// Ticker on a tinted rounded tile. Tint and text colour are mixed from the
// hue and the theme's own surface/text variables, so it reads in both themes.
export function SymbolTile({ cashTicker, size = 'md' }: { cashTicker: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`symbol-tile symbol-tile-${size}`} style={{ '--hue': tileHue(cashTicker) } as CSSProperties} aria-hidden="true">
      {cashTicker}
    </span>
  );
}
