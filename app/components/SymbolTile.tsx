'use client';

import { useState, type CSSProperties } from 'react';
import { tileHue } from '@/lib/symbolStyle';
import { useTokenIcon } from './TokenIcons';

// The token's icon when Coinbase supplies one; otherwise (or if the image
// fails to load) the ticker on a tinted rounded tile. Tint and text colour are
// mixed from the hue and the theme's own variables, so the fallback reads in
// both themes.
export function SymbolTile({ cashTicker, size = 'md' }: { cashTicker: string; size?: 'sm' | 'md' }) {
  const icon = useTokenIcon(cashTicker);
  const [failed, setFailed] = useState(false);

  if (icon && !failed) {
    return (
      <span className={`symbol-icon symbol-icon-${size}`} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className={`symbol-tile symbol-tile-${size}`} style={{ '--hue': tileHue(cashTicker) } as CSSProperties} aria-hidden="true">
      {cashTicker}
    </span>
  );
}
