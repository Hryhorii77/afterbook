import { describe, expect, it, vi, beforeEach } from 'vitest';

// Basenames both ways (2026-11-26). A reverse name counts only if it points back to the same address: anyone can set
// any reverse name on their own address. Offline: the chain client is a fake.
const fx = vi.hoisted(() => ({ reverse: null as string | null, forward: null as string | null, resolver: '0x00000000000000000000000000000000000000AA', fail: null as string | null }));
vi.mock('../lib/market/quote', () => ({
  getClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (fx.fail === functionName) throw new Error('rpc down');
      if (functionName === 'name') return fx.reverse ?? '';
      if (functionName === 'resolver') return fx.resolver;
      if (functionName === 'addr') return fx.forward ?? '0x0000000000000000000000000000000000000000';
      throw new Error('unexpected ' + functionName);
    },
  }),
}));

import { addressOfBasename, resolveBasename } from '../lib/wallet/basename';

const ADDR = '0x2211d1D0020DAEA8039E46Cf1367962070d77DA9' as const;
beforeEach(() => Object.assign(fx, { reverse: null, forward: null, resolver: '0x00000000000000000000000000000000000000AA', fail: null }));

describe('resolveBasename (address → name, checked forward)', () => {
  it('shows the name when it points back to the address, in any case', async () => {
    fx.reverse = 'jesse.base.eth';
    fx.forward = ADDR.toLowerCase();
    expect(await resolveBasename(ADDR)).toBe('jesse.base.eth');
  });
  it('hides a reverse name that points to a different address (an impersonation)', async () => {
    fx.reverse = 'jesse.base.eth';
    fx.forward = '0x1111111111111111111111111111111111111111';
    expect(await resolveBasename(ADDR)).toBeNull();
  });
  it('hides it when the forward name has no address, and on any read failure', async () => {
    fx.reverse = 'jesse.base.eth';
    expect(await resolveBasename(ADDR)).toBeNull();
    fx.forward = ADDR;
    fx.fail = 'addr';
    expect(await resolveBasename(ADDR)).toBeNull();
    fx.fail = 'name';
    expect(await resolveBasename(ADDR)).toBeNull();
  });
});

describe('addressOfBasename (name → address)', () => {
  it('reads the resolver, then its address; none when either is empty', async () => {
    fx.forward = ADDR;
    expect(await addressOfBasename('Jesse')).toBe(ADDR);
    fx.forward = null;
    expect(await addressOfBasename('jesse')).toBeNull();
    fx.resolver = '0x0000000000000000000000000000000000000000';
    expect(await addressOfBasename('jesse')).toBeNull();
    expect(await addressOfBasename('not a name')).toBeNull();
  });
  it('a read failure throws, so it never reads as "points to no wallet"', async () => {
    fx.fail = 'resolver';
    await expect(addressOfBasename('jesse')).rejects.toThrow('rpc down');
  });
});
