import { describe, expect, it, vi, beforeEach } from 'vitest';

// The ledger write (2026-11-25): one record per settlement transaction, a retry or a second report of the same
// settlement is no second call, a malformed transaction id is never stored, and a store error never throws (the
// paid answer must go through). Redis is a fake that behaves like HSETNX.
const fx = vi.hoisted(() => ({ hash: new Map<string, string>(), fail: false }));
vi.mock('../lib/server/redis', () => ({
  redis: {
    hsetnx: async (_k: string, field: string, value: string) => {
      if (fx.fail) throw new Error('upstash down');
      if (fx.hash.has(field)) return 0;
      fx.hash.set(field, value);
      return 1;
    },
    hgetall: async () => Object.fromEntries(fx.hash),
  },
}));

import { paidCalls, recordPaidCall, summarizePaidCalls } from '../lib/server/x402Ledger';

const TX = '0x94CCAA1A784DE047B268C5146A6A0C76EBF919E23C2F989808653D1D5C7425B5';
const call = (tx = TX) => ({ tx, route: 'plan' as const, amount: '50000', payer: '0x5338acAc2c7F5dbdfAfe0Ef4829B5c419d8c3F38', at: 1764074751000 });

beforeEach(() => {
  fx.hash.clear();
  fx.fail = false;
});

describe('x402 ledger write', () => {
  it('records a settlement once, by its transaction in lower case, however often it is reported', async () => {
    await recordPaidCall(call());
    await recordPaidCall(call());
    await recordPaidCall(call(TX.toLowerCase()));
    expect([...fx.hash.keys()]).toEqual([TX.toLowerCase()]);
    const calls = await paidCalls();
    expect(summarizePaidCalls(calls ?? [])).toMatchObject({ calls: 1, usdc: 0.05 });
  });
  it('never stores a malformed transaction id', async () => {
    await recordPaidCall(call('0x1234'));
    await recordPaidCall(call('not-a-hash'));
    expect(fx.hash.size).toBe(0);
  });
  it('a store error is swallowed, so the paid answer still goes through', async () => {
    fx.fail = true;
    await expect(recordPaidCall(call())).resolves.toBeUndefined();
  });
});
