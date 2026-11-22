// "Start automation" needs the owner's signature (2026-11-22, from an outside review): POST /api/baskets/start used
// to accept any owner address, so anyone could restart Basis Tilt rebalancing on someone else's portfolio. Now the
// browser has the wallet sign this exact text (EIP-191 personal_sign; a smart wallet such as Base Account signs
// through ERC-1271, checked by viem's verifyMessage on the server) and the route verifies it against the owner
// before calling Glider. The time in it limits a signature to a few minutes; replaying one inside that window only
// restarts what its owner just asked to start. Pure; safe for the browser.
import { getAddress } from 'viem';

/** How old a signed start may be, and how far in the future (a clock a little ahead). */
export const START_MAX_AGE_MS = 5 * 60_000;
export const START_MAX_SKEW_MS = 60_000;

export function startMessage(owner: string, issuedAt: number): string {
  return [
    'Afterbook: start Basis Tilt automation',
    `Wallet: ${getAddress(owner)}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    'This only restarts scheduled rebalancing of your own Basis Tilt portfolio. It moves no funds.',
  ].join('\n');
}

/** null when `issuedAt` is fresh, else why not. */
export function startAgeProblem(issuedAt: unknown, now = Date.now()): string | null {
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) return 'issuedAt must be a time in milliseconds';
  if (issuedAt > now + START_MAX_SKEW_MS) return 'the signed time is in the future; check your device clock';
  if (now - issuedAt > START_MAX_AGE_MS) return 'the signature is too old; press Start again';
  return null;
}
