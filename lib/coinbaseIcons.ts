import { fetchCoinbaseStockList } from './coinbaseStockList';
import { STOCKS } from './tokens';

// Coinbase's public, keyless tokenized-stock list. Each entry carries the
// issuer-served icon for that token. We read it on the server (cached by
// Next's fetch cache for six hours, served stale while revalidating) and pass
// plain URLs to the browser, so rows never call the API themselves.
export const ICON_HOST = 'https://metadata.coinbase.com/equity_icons/';

/** Icon URL by underlying cash ticker (e.g. "AAPL"), only for tokens Afterbook tracks.
 *  An entry is used only if its contract address matches the one in lib/tokens.ts
 *  AND the URL is an https icon on Coinbase's own metadata host, so a wrong or
 *  odd record can never swap in a different token's image or an arbitrary URL.
 *  Any failure returns an empty map and the app keeps its letter tiles. */
export async function getTokenIcons(): Promise<Record<string, string>> {
  try {
    const tokens = await fetchCoinbaseStockList({ next: { revalidate: 6 * 60 * 60 } });
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
