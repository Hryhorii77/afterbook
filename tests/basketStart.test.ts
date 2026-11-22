import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startAgeProblem, startMessage, START_MAX_AGE_MS } from '../lib/baskets/startAuth';
import { gliderKernelAddress, GLIDER_SALT_BASE } from '../lib/baskets/depositAccount';

// "Start automation" needs the owner's signature: before 2026-11-22 anyone could restart another wallet's
// Basis Tilt automation by posting its address. Offline: Glider, the region guard and the chain client are
// fakes; signatures come from throwaway keys made here (EOA path of viem's verifyMessage).
const fx = vi.hoisted(() => ({ started: [] as string[], account: '' as string, chainProblem: null as string | null }));
vi.mock('../lib/baskets/glider', () => ({
  listPortfolios: async () => ({ portfolios: [{ portfolioId: 'pf-1', smartAccounts: [{ accountId: `eip155:8453:${fx.account}` }] }] }),
  startPortfolio: async (id: string) => (fx.started.push(id), { ok: true }),
}));
vi.mock('../lib/baskets/guard', async (orig) => ({
  ...(await orig<typeof import('../lib/baskets/guard')>()),
  guardBasketRequest: async () => null,
  strategyId: () => 'strategy-1',
}));
vi.mock('../lib/market/quote', () => ({ getClient: () => ({ verifyMessage }) }));
// The address maths run for real (the account is derived from the test wallet below); the chain reads are faked.
vi.mock('../lib/baskets/depositAccount', async (orig) => ({
  ...(await orig<typeof import('../lib/baskets/depositAccount')>()),
  deployedAccountProblem: async () => fx.chainProblem,
}));
const used = new Set<string>();
vi.mock('../lib/server/redis', () => ({ redis: { set: async (k: string) => (used.has(k) ? null : (used.add(k), 'OK')) } }));

import { POST } from '../app/api/baskets/start/route';

const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const ownAccount = gliderKernelAddress(owner.address, GLIDER_SALT_BASE);
const post = (body: unknown) =>
  POST(new NextRequest('https://afterbook.app/api/baskets/start', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  fx.started = [];
  fx.account = ownAccount;
  fx.chainProblem = null;
});

describe('POST /api/baskets/start', () => {
  it('starts with the owner’s fresh signature', async () => {
    const issuedAt = Date.now();
    const signature = await owner.signMessage({ message: startMessage(owner.address, issuedAt) });
    const res = await post({ owner: owner.address, issuedAt, signature });
    expect(res.status).toBe(200);
    expect(fx.started).toEqual(['pf-1']);
    // The same request again: refused, single use.
    expect((await post({ owner: owner.address, issuedAt, signature })).status).toBe(401);
    // The same signature written another way (v as 0/1 instead of 27/28): still the same signed start, refused.
    const v = parseInt(signature.slice(-2), 16);
    const reencoded = signature.slice(0, -2) + (v - 27).toString(16).padStart(2, '0');
    // It really is a valid signature of the same text, so only the single-use check refuses it.
    expect(await verifyMessage({ address: owner.address, message: startMessage(owner.address, issuedAt), signature: reencoded as `0x${string}` })).toBe(true);
    expect((await post({ owner: owner.address, issuedAt, signature: reencoded })).status).toBe(401);
    expect(fx.started).toEqual(['pf-1']);
  });

  it('never starts an account that isn’t the wallet’s own, or one the chain shows tampered with', async () => {
    fx.account = gliderKernelAddress(stranger.address, GLIDER_SALT_BASE);
    let issuedAt = Date.now();
    let signature = await owner.signMessage({ message: startMessage(owner.address, issuedAt) });
    expect((await post({ owner: owner.address, issuedAt, signature })).status).toBe(409);
    fx.account = ownAccount;
    fx.chainProblem = 'its root validator changed.';
    issuedAt += 1;
    signature = await owner.signMessage({ message: startMessage(owner.address, issuedAt) });
    expect((await post({ owner: owner.address, issuedAt, signature })).status).toBe(409);
    expect(fx.started).toEqual([]);
  });

  it('takes the owner in any letter case, a wrong checksum included (never a 500)', async () => {
    const issuedAt = Date.now();
    const signature = await owner.signMessage({ message: startMessage(owner.address, issuedAt) });
    expect((await post({ owner: owner.address.toLowerCase(), issuedAt, signature })).status).toBe(200);
    const badCase = owner.address.slice(0, 2) + [...owner.address.slice(2)].map((c) => (/[a-f]/.test(c) ? c.toUpperCase() : /[A-F]/.test(c) ? c.toLowerCase() : c)).join('');
    const sig2 = await owner.signMessage({ message: startMessage(owner.address, issuedAt + 1) });
    const res = await post({ owner: badCase, issuedAt: issuedAt + 1, signature: sig2 });
    // The case is normalised before the check (the signature, not the checksum, decides): no 500.
    expect(res.status).toBe(200);
  });

  it('refuses no signature, someone else’s, a stale one, and one over different text', async () => {
    const issuedAt = Date.now();
    expect((await post({ owner: owner.address })).status).toBe(401);
    const byStranger = await stranger.signMessage({ message: startMessage(owner.address, issuedAt) });
    expect((await post({ owner: owner.address, issuedAt, signature: byStranger })).status).toBe(401);
    const old = Date.now() - START_MAX_AGE_MS - 1000;
    const stale = await owner.signMessage({ message: startMessage(owner.address, old) });
    expect((await post({ owner: owner.address, issuedAt: old, signature: stale })).status).toBe(401);
    // Signed for one time, sent with another: the text no longer matches.
    const signed = await owner.signMessage({ message: startMessage(owner.address, issuedAt) });
    expect((await post({ owner: owner.address, issuedAt: issuedAt + 1, signature: signed })).status).toBe(401);
    expect(fx.started).toEqual([]);
  });

  it('checks the time', () => {
    const now = 1_800_000_000_000;
    expect(startAgeProblem(now - 1000, now)).toBeNull();
    expect(startAgeProblem(now + 5 * 60_000, now)).toMatch(/future/);
    expect(startAgeProblem(now - START_MAX_AGE_MS - 1, now)).toMatch(/too old/);
    expect(startAgeProblem('now', now)).toMatch(/milliseconds/);
  });
});
