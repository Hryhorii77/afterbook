// Free API keys for /api/v1/tape (POST /api/v1/keys). Since 2026-11-22 (from an outside review) a key is stored
// only as its SHA-256 hash, with a one-year expiry: before, Redis held the key itself (`apikey:<key>`) with no
// expiry, so anyone who could read the store could use every key. A key issued before then still works: the
// first time it is used it is moved to the hashed form (with a fresh year) and the plain copy is deleted.
import { createHash, randomBytes } from 'node:crypto';
import { redis } from './redis';

export const API_KEY_TTL_S = 365 * 24 * 3600;
export const API_KEY_RE = /^ab_[0-9a-f]{32}$/;
export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');
const HASHED = (key: string) => `apikey:h:${hashApiKey(key)}`;
const LEGACY = (key: string) => `apikey:${key}`;

/** A new key and when it expires; only the hash is stored. Throws if the store write fails. */
export async function issueApiKey(now = Date.now()): Promise<{ key: string; expiresAt: number }> {
  const key = `ab_${randomBytes(16).toString('hex')}`;
  const expiresAt = now + API_KEY_TTL_S * 1000;
  await redis!.set(HASHED(key), { createdAt: now, expiresAt, tier: 'free' }, { ex: API_KEY_TTL_S });
  return { key, expiresAt };
}

/** Whether the key is valid (not expired). A key in the old plain form is moved to the hashed one on use. */
export async function checkApiKey(key: string, now = Date.now()): Promise<boolean> {
  if (!redis || !API_KEY_RE.test(key)) return false;
  if (await redis.get(HASHED(key))) return true;
  const legacy = await redis.get<{ createdAt?: number }>(LEGACY(key));
  if (!legacy) return false;
  await redis.set(HASHED(key), { createdAt: legacy.createdAt ?? now, expiresAt: now + API_KEY_TTL_S * 1000, tier: 'free' }, { ex: API_KEY_TTL_S });
  await redis.del(LEGACY(key));
  return true;
}
