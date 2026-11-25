import { getCoinbaseStockList } from './coinbaseListGuard';
import { STOCKS } from './tokens';

// Coinbase's public, keyless tokenized-stock list. Each entry carries the
// issuer-served icon for that token. We read it on the server (cached by
// Next's fetch cache for six hours, served stale while revalidating) and pass
// plain URLs to the browser, so rows never call the API themselves.
export const ICON_HOST = 'https://metadata.coinbase.com/equity_icons/';

/** Icon URL by underlying cash ticker (e.g. "AAPL"), only for tokens Afterbook tracks.
 *  An entry is used only if its contract address matches the one in lib/stocks/tokens.ts
 *  AND the URL is an https icon on Coinbase's own metadata host, so a wrong or
 *  odd record can never swap in a different token's image or an arbitrary URL.
 *  Any failure returns an empty map and the app keeps its letter tiles. */
// The root layout awaits this on every page, and the list can take several 8-second pages from Coinbase: once it
// held a page for ~30 s (review, 2026-11-25). So the wait is boxed at ICONS_WAIT_MS: past it the page gets the last
// map this instance read (or none: letter tiles) while the read carries on and fills that map for the next page.
const ICONS_WAIT_MS = 1500;
let lastIcons: Record<string, string> | null = null;
let inFlight: Promise<Record<string, string>> | null = null;

export async function getTokenIcons(waitMs = ICONS_WAIT_MS): Promise<Record<string, string>> {
  inFlight ??= readTokenIcons().then((icons) => {
    if (Object.keys(icons).length) lastIcons = icons;
    inFlight = null;
    return icons;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
  try {
    return (await Promise.race([inFlight, timedOut])) ?? lastIcons ?? {};
  } finally {
    clearTimeout(timer); // icons first: no timer left behind (review of #241)
  }
}

async function readTokenIcons(): Promise<Record<string, string>> {
  try {
    const tokens = await getCoinbaseStockList({ next: { revalidate: 6 * 60 * 60 } });
    const byAddress = new Map<string, string>();
    for (const t of tokens) {
      if (typeof t.contract_address === 'string' && typeof t.icon_url === 'string' && t.icon_url.startsWith(ICON_HOST)) {
        byAddress.set(t.contract_address.toLowerCase(), t.icon_url);
      }
    }
    const out: Record<string, string> = {};
    for (const s of STOCKS) {
      const url = byAddress.get(s.tokenAddress.toLowerCase());
      if (url) out[s.cashTicker] = url;
    }
    return out;
  } catch {
    return {};
  }
}
