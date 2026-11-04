// Coinbase's public, keyless tokenized-stock list, every page of it. The endpoint returns 100 tokens
// per page with a `next_page_token`; reading only the first page silently dropped AAPLc, AMZNc and
// MUc (no icons, letter tiles) and hid 45 tokens from the discovery cron (found 2026-10-14).
const LIST_URL = 'https://api.coinbase.com/v1/tokenized-stocks';
const MAX_PAGES = 10;

/** A listed symbol: letters and digits, an optional share class after a dot (`BRK.Bc`, listed
 *  2026-11-04, which the old `/^[A-Z0-9]+c$/` dropped from /stocks and discovery), then the `c`. */
export const LISTED_SYMBOL_RE = /^[A-Z0-9]+(?:\.[A-Z])?c$/;
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** A listed token the site leaves out, and why; the daily discovery digest reports each one once. */
export interface SkippedListing {
  symbol: string;
  address: string;
  reason: string;
}

/**
 * The tokens /stocks and discovery use (a symbol matching LISTED_SYMBOL_RE, a contract address, the
 * first entry per symbol) and the ones they skip. Skipped tokens used to vanish silently: BRK.Bc
 * was missing from /stocks until someone counted.
 */
export function splitListedTokens(tokens: ListedToken[]): { kept: ListedToken[]; skipped: SkippedListing[] } {
  const kept: ListedToken[] = [];
  const skipped: SkippedListing[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const symbol = typeof t.symbol === 'string' ? t.symbol : '';
    const address = typeof t.contract_address === 'string' ? t.contract_address : '';
    const reason = !LISTED_SYMBOL_RE.test(symbol)
      ? 'unexpected symbol format'
      : !ADDRESS_RE.test(address)
        ? 'no valid contract address'
        : seen.has(symbol)
          ? 'duplicate symbol'
          : null;
    if (reason) {
      skipped.push({ symbol: symbol.slice(0, 24) || '(no symbol)', address: address.slice(0, 42) || '(none)', reason });
      continue;
    }
    seen.add(symbol);
    kept.push(t);
  }
  return { kept, skipped };
}

export interface ListedToken {
  symbol?: unknown;
  name?: unknown;
  contract_address?: unknown;
  icon_url?: unknown;
}

/** All tokens across pages. Throws on any failed page, so callers never act on half a list. */
export async function fetchCoinbaseStockList(init: RequestInit & { next?: { revalidate?: number } } = {}): Promise<ListedToken[]> {
  const tokens: ListedToken[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = pageToken ? `${LIST_URL}?page_token=${encodeURIComponent(pageToken)}` : LIST_URL;
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Coinbase tokenized-stocks fetch failed: ${res.status}`);
    const json = (await res.json()) as { tokens?: ListedToken[]; next_page_token?: unknown };
    tokens.push(...(json.tokens ?? []));
    pageToken = typeof json.next_page_token === 'string' && json.next_page_token ? json.next_page_token : null;
    if (!pageToken) return tokens;
  }
  throw new Error(`Coinbase tokenized-stocks list has more than ${MAX_PAGES} pages`);
}
