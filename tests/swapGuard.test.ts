// guardSwapRequest is the front door of every /api/swap/* route: it must fail closed on region and on a
// missing rate limiter. The region lookup and the limiter are mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = { nonUs: true, limiter: true as boolean, allow: true };
vi.mock('../lib/geo', () => ({ getGeoInfo: vi.fn(async () => ({ nonUs: state.nonUs, country: state.nonUs ? 'DE' : 'US' })) }));
vi.mock('../lib/ratelimit', () => ({
  get swapLimiter() {
    return state.limiter ? { limit: vi.fn(async () => ({ success: state.allow })) } : null;
  },
}));

const { guardSwapRequest } = await import('../lib/swapGuard');
const request = () => new NextRequest('https://afterbook.app/api/swap/quote', { headers: { 'x-forwarded-for': '203.0.113.7' } });

beforeEach(() => Object.assign(state, { nonUs: true, limiter: true, allow: true }));

describe('guardSwapRequest', () => {
  it('lets a non-US caller under the limit through', async () => {
    expect(await guardSwapRequest(request())).toBeNull();
  });
  it('refuses a US (or unknown) region with 403', async () => {
    state.nonUs = false;
    expect((await guardSwapRequest(request()))?.status).toBe(403);
  });
  it('refuses with 503 when there is no rate limiter', async () => {
    state.limiter = false;
    expect((await guardSwapRequest(request()))?.status).toBe(503);
  });
  it('refuses with 429 over the limit', async () => {
    state.allow = false;
    expect((await guardSwapRequest(request()))?.status).toBe(429);
  });
});
