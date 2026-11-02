import { describe, expect, it, vi } from 'vitest';

// The Redis-backed limiters in lib/ratelimit.ts are built at import; keep the test offline.
vi.mock('../lib/redis', () => ({ redis: null }));
vi.mock('@/lib/redis', () => ({ redis: null }));

import { MemoryLimiter } from '../lib/ratelimit';
import { limitRead } from '../lib/readGuard';

const req = (ip: string) => new Request('https://afterbook.app/api/x', { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });

describe('MemoryLimiter', () => {
  it('allows the set number per window, then refuses until the window ends', () => {
    const l = new MemoryLimiter(3, 60_000);
    const t = 1_000_000;
    expect([1, 2, 3].map(() => l.limit('k', t).success)).toEqual([true, true, true]);
    expect(l.limit('k', t + 59_999).success).toBe(false);
    expect(l.limit('k', t + 60_000).success).toBe(true);
  });

  it('counts each key on its own', () => {
    const l = new MemoryLimiter(1, 60_000);
    expect(l.limit('a', 0).success).toBe(true);
    expect(l.limit('a', 1).success).toBe(false);
    expect(l.limit('b', 1).success).toBe(true);
  });
});

describe('limitRead', () => {
  it('refuses /api/lots after 10 calls a minute from one IP, with Retry-After', async () => {
    const t = 5_000_000;
    for (let i = 0; i < 10; i++) expect(limitRead(req('1.2.3.4'), 'lots', 'lots', t)).toBeNull();
    const res = limitRead(req('1.2.3.4'), 'lots', 'lots', t + 30_000);
    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBe('30');
    expect(limitRead(req('5.6.7.8'), 'lots', 'lots', t + 30_000)).toBeNull();
  });

  it('counts routes separately for the same IP', () => {
    const t = 9_000_000;
    for (let i = 0; i < 60; i++) expect(limitRead(req('9.9.9.9'), 'depth', 'read', t)).toBeNull();
    expect(limitRead(req('9.9.9.9'), 'depth', 'read', t)?.status).toBe(429);
    expect(limitRead(req('9.9.9.9'), 'quote', 'read', t)).toBeNull();
  });
});
