// Coinbase's public, keyless tokenized-stock list, every page of it. The endpoint returns 100 tokens
// per page with a `next_page_token`; reading only the first page silently dropped AAPLc, AMZNc and
// MUc (no icons, letter tiles) and hid 45 tokens from the discovery cron (found 2026-10-14).
const LIST_URL = 'https://api.coinbase.com/v1/tokenized-stocks';
const MAX_PAGES = 10;

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
