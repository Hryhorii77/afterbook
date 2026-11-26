// What someone typed into "Look up a wallet" (2026-11-26, /portfolio and /borrow): a 0x address or a Basename. Pure;
// safe for the browser. Looking a wallet up is read-only: public balances and loans, never a signature.
import { getAddress, isAddress } from 'viem';

/** A Basename as typed ("jesse", "jesse.base.eth", any case) in its full lower-case form, or null if it isn't one. */
export function normalizeBasename(input: string): string | null {
  const name = input.trim().toLowerCase();
  const full = name.endsWith('.base.eth') ? name : `${name}.base.eth`;
  return /^[a-z0-9-]{1,63}\.base\.eth$/.test(full) && !full.startsWith('-') ? full : null;
}

export type WalletInput = { kind: 'address'; address: `0x${string}` } | { kind: 'name'; name: string };

/** An address (checksummed) or a Basename, or null for anything else. */
export function parseWalletInput(input: string): WalletInput | null {
  const s = input.trim();
  // Anything typed as 0x… is meant as an address: a malformed one is refused, never looked up as a name.
  if (/^0x/i.test(s)) return /^0x[0-9a-fA-F]{40}$/.test(s) && isAddress(s, { strict: false }) ? { kind: 'address', address: getAddress(s.toLowerCase()) } : null;
  const name = normalizeBasename(s);
  return name ? { kind: 'name', name } : null;
}
