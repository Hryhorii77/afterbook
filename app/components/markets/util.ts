// Small helpers shared by the Markets page's sections.
import { useState } from 'react';

export const SIZE_PRESETS_USDC = [250, 1_000, 5_000];

export const shares = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

export const truncateAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** Copies text and says "copied" for 1.5 s; clipboard access denied leaves the button as it was. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied — nothing to fall back to, button just won't confirm
    }
  };
  return { copied, copy };
}

// Fires alongside every outbound Execute click, purely to log that it
// happened — never gates or delays the link itself. sendBeacon (not
// fetch) because it queues the send and returns immediately even as the
// browser navigates away to open the new tab, which a blocking fetch call
// in a click handler can't guarantee. Best-effort: no error handling,
// since there's nothing useful to do with a dropped analytics beacon.
export function logOutboundClick(symbol: string, usdIn: number | null, venue: 'aerodrome-swap' | 'aerodrome-deposit', direction?: 'buy' | 'sell') {
  try {
    const body = JSON.stringify({ symbol, usdIn, venue, direction });
    navigator.sendBeacon('/api/clicks', new Blob([body], { type: 'application/json' }));
  } catch {
    // sendBeacon unsupported or blocked — click still proceeds either way
  }
}
