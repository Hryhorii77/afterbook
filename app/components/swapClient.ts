// Browser-side helpers shared by the swap panels (SwapPanel: one stock; BasketBuyPanel: a /build
// basket). No React and no wallet calls here: fetching our own /api/swap routes and formatting.
import { formatUnits } from 'viem';

export async function api<T>(path: string, init?: { body: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init ? 'POST' : 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

// Reports a confirmed swap for the metrics; retried because the server's RPC can lag the wallet's.
export async function logSwapHash(hash: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api('/api/swap/log', { body: { hash } });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// KyberSwap's venue ids ("aerodrome-cl-3", "sectorone-v20") as names a trader recognises.
export const venueNames = (venues: string[]) => {
  const named = new Set(venues.map((v) => (/aerodrome/i.test(v) ? 'Aerodrome' : /^aero/i.test(v) ? 'Aero' : /uniswap/i.test(v) ? 'Uniswap' : 'other Base pools')));
  return [...named].sort((a, b) => (a === 'other Base pools' ? 1 : b === 'other Base pools' ? -1 : a.localeCompare(b))).join(' and ');
};

export const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fmt = (raw: string | bigint, decimals: number, max = 4) =>
  Number(formatUnits(BigInt(raw), decimals)).toLocaleString('en-US', { maximumFractionDigits: max });
