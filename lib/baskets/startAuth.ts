// Basket actions Glider takes without the owner's own signature need Afterbook to check one first (2026-11-22, from
// outside reviews): POST /api/baskets/start used to accept any owner address, so anyone could restart Basis Tilt
// rebalancing on someone else's portfolio; and a withdrawal's stage 1 with `liquidate: true` might start selling
// before the owner signs anything (unconfirmed with Glider). The browser has the wallet sign this exact text
// (EIP-191 personal_sign; a smart wallet such as Base Account signs through ERC-1271/6492, checked by viem's
// verifyMessage on the server), naming the site, the chain, the action, the wallet and the time. The server
// refuses a signature that is too old, and remembers each (action, wallet, time) once, so a signature works once
// however it is encoded (review of #214: a signature can be written several valid ways). Pure; browser-safe.
import { getAddress } from 'viem';

/** How old a signed action may be, and how far in the future (a clock a little ahead). */
export const START_MAX_AGE_MS = 5 * 60_000;
export const START_MAX_SKEW_MS = 60_000;

export type OwnerAction = 'start' | 'withdraw-sell';

const WHAT: Record<OwnerAction, string[]> = {
  start: ['Action: start Basis Tilt automation', 'This only restarts scheduled rebalancing of your own Basis Tilt portfolio. It moves no funds.'],
  'withdraw-sell': [
    'Action: prepare a withdrawal that sells to USDC',
    'This asks Glider to prepare a withdrawal of your own Basis Tilt portfolio that sells it to USDC, paid to your own wallet; you review and sign that withdrawal next.',
  ],
};

export function ownerActionMessage(action: OwnerAction, owner: string, issuedAt: number): string {
  return [
    `Afterbook: ${action === 'start' ? 'start Basis Tilt automation' : 'withdraw from Basis Tilt'}`,
    'URI: https://afterbook.app',
    'Chain ID: 8453',
    WHAT[action][0],
    `Wallet: ${getAddress(owner)}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    WHAT[action][1],
  ].join('\n');
}

export const startMessage = (owner: string, issuedAt: number) => ownerActionMessage('start', owner, issuedAt);

/** The single-use key: what was signed, not the signature's bytes (which have several valid encodings). */
export const ownerActionKey = (action: OwnerAction, owner: string, issuedAt: number) => `basketauth:${action}:${getAddress(owner)}:${issuedAt}`;

/** null when `issuedAt` is fresh, else why not. */
export function startAgeProblem(issuedAt: unknown, now = Date.now()): string | null {
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt)) return 'issuedAt must be a time in milliseconds';
  if (issuedAt > now + START_MAX_SKEW_MS) return 'the signed time is in the future; check your device clock';
  if (now - issuedAt > START_MAX_AGE_MS) return 'the signature is too old; try again';
  return null;
}
