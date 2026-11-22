// The server half of lib/baskets/startAuth.ts: checks an owner's signed basket action (age, signer, single use).
import 'server-only';
import { NextResponse } from 'next/server';
import { getAddress } from 'viem';
import { getClient } from '../market/quote';
import { redis } from '../server/redis';
import { ownerActionKey, ownerActionMessage, startAgeProblem, START_MAX_AGE_MS, type OwnerAction } from './startAuth';

/** null when the body carries the owner's fresh, unused signature for `action` (and marks it used); otherwise the
 *  401 to send. */
export async function ownerActionRefusal(action: OwnerAction, owner: string, issuedAt: unknown, signature: unknown): Promise<NextResponse | null> {
  return (await ownerActionSignatureRefusal(action, owner, issuedAt, signature)) ?? (await consumeOwnerAction(action, owner, issuedAt as number));
}

/** The signature and age only, without marking it used: for a route that has more checks to make first, so a
 *  refusal it can't help (a chain read that failed) doesn't cost the person a new signature. */
export async function ownerActionSignatureRefusal(action: OwnerAction, owner: string, issuedAt: unknown, signature: unknown): Promise<NextResponse | null> {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature) || signature.length > 20_000) {
    return NextResponse.json({ error: 'a signature from the owner is required' }, { status: 401 });
  }
  const stale = startAgeProblem(issuedAt);
  if (stale) return NextResponse.json({ error: stale }, { status: 401 });
  // Normalised first: a wrong-checksum spelling of the address is refused by the signature, never a 500.
  const wallet = getAddress(owner.toLowerCase());
  // EOA signatures, and smart wallets (ERC-1271, or ERC-6492 before the account is deployed), on Base.
  const valid = await getClient()
    .verifyMessage({ address: wallet, message: ownerActionMessage(action, wallet, issuedAt as number), signature: signature as `0x${string}` })
    .catch(() => false);
  if (!valid) return NextResponse.json({ error: 'the signature is not from this wallet' }, { status: 401 });
  return null;
}

/** Marks a checked signature used; the 401 to send if it already was. */
export async function consumeOwnerAction(action: OwnerAction, owner: string, issuedAt: number): Promise<NextResponse | null> {
  const wallet = getAddress(owner.toLowerCase());
  // Single use, keyed on what was signed: the same signature re-encoded is the same key. Without a store (or if it
  // errors) the time limit alone applies.
  const fresh = redis
    ? await redis.set(ownerActionKey(action, wallet, issuedAt), 1, { nx: true, ex: Math.ceil(START_MAX_AGE_MS / 1000) + 60 }).catch(() => 'OK')
    : 'OK';
  if (fresh == null) return NextResponse.json({ error: 'this signature was already used; try again' }, { status: 401 });
  return null;
}
