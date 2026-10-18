'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { tileHue } from '@/lib/symbolStyle';
import { useTokenIcon } from './TokenIcons';

// The token's icon when Coinbase supplies one; otherwise (or if the image
// fails to load) the ticker on a tinted rounded tile. Tint and text colour are
// mixed from the hue and the theme's own variables, so the fallback reads in
// both themes.
// `iconUrl` overrides the tracked-token lookup (the /stocks directory passes Coinbase's icon for untracked tokens).
export function SymbolTile({ cashTicker, size = 'md', iconUrl }: { cashTicker: string; size?: 'sm' | 'md'; iconUrl?: string | null }) {
  const tracked = useTokenIcon(cashTicker);
  const icon = iconUrl === undefined ? tracked : iconUrl;
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // An image that failed before React attached onError (server-rendered, then hydrated) never
  // fires it again: catch that case on mount, or the row shows a broken image instead of the tile.
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, [icon]);

  if (icon && !failed) {
    return (
      <span className={`symbol-icon symbol-icon-${size}`} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={img} src={icon} alt="" width={40} height={40} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </span>
    );
  }
  return (
    <span className={`symbol-tile symbol-tile-${size}`} style={{ '--hue': tileHue(cashTicker) } as CSSProperties} aria-hidden="true">
      {cashTicker}
    </span>
  );
}
