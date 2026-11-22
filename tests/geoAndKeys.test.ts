import { describe, expect, it, vi, beforeEach } from 'vitest';

// The region gate counts US territories as the US, and free API keys are stored only as hashes with an expiry
// (old plain keys keep working and are moved on first use). Offline: request headers and Redis are fakes.
const fx = vi.hoisted(() => ({ country: null as string | null, store: new Map<string, { v: unknown; ex?: number }>() }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(fx.country ? { 'x-vercel-ip-country': fx.country } : {}) }));
vi.mock('../lib/server/redis', () => ({
  redis: {
    get: async (k: string) => fx.store.get(k)?.v ?? null,
    set: async (k: string, v: unknown, o?: { ex?: number }) => (fx.store.set(k, { v, ex: o?.ex }), 'OK'),
    del: async (k: string) => Number(fx.store.delete(k)),
  },
}));

import { getGeoInfo } from '../lib/server/geo';
import { API_KEY_TTL_S, checkApiKey, hashApiKey, issueApiKey } from '../lib/server/apiKeys';

describe('region gate', () => {
  it('treats the US and its territories alike, fails closed on no header, and lets others through', async () => {
    for (const c of ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'UM']) {
      fx.country = c;
      expect(await getGeoInfo()).toMatchObject({ nonUs: false, us: true });
    }
    fx.country = null;
    expect(await getGeoInfo()).toMatchObject({ nonUs: false, us: false });
    fx.country = '';
    expect(await getGeoInfo()).toMatchObject({ nonUs: false, us: false, country: null });
    fx.country = 'DE';
    expect(await getGeoInfo()).toMatchObject({ nonUs: true, us: false });
  });
});

describe('API keys', () => {
  beforeEach(() => fx.store.clear());

  it('stores only the hash, with a year’s expiry', async () => {
    const { key, expiresAt } = await issueApiKey(1_000);
    expect(key).toMatch(/^ab_[0-9a-f]{32}$/);
    expect(expiresAt).toBe(1_000 + API_KEY_TTL_S * 1000);
    expect([...fx.store.keys()]).toEqual([`apikey:h:${hashApiKey(key)}`]);
    expect(JSON.stringify([...fx.store])).not.toContain(key);
    expect(fx.store.get(`apikey:h:${hashApiKey(key)}`)?.ex).toBe(API_KEY_TTL_S);
    expect(await checkApiKey(key)).toBe(true);
  });

  it('moves an old plain key to the hashed form on first use, and refuses junk', async () => {
    const old = `ab_${'a'.repeat(32)}`;
    fx.store.set(`apikey:${old}`, { v: { createdAt: 5, tier: 'free' } });
    expect(await checkApiKey(old)).toBe(true);
    expect(fx.store.has(`apikey:${old}`)).toBe(false);
    expect(fx.store.get(`apikey:h:${hashApiKey(old)}`)).toMatchObject({ v: { createdAt: 5 }, ex: API_KEY_TTL_S });
    expect(await checkApiKey(old)).toBe(true);
    expect(await checkApiKey(`ab_${'b'.repeat(32)}`)).toBe(false);
    expect(await checkApiKey('not-a-key')).toBe(false);
  });
});
