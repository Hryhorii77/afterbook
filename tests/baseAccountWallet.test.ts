// The Base Account wrapper (lib/wallet/baseAccountWallet.ts): a page reload reconnects from the saved
// session with eth_accounts and never sends wallet_connect (which opens a Coinbase window).
import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const listeners = new Map<string, Set<unknown>>();
let saved: string[] = [];
const provider = {
  request: vi.fn(async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === 'eth_accounts') return saved;
    if (method === 'eth_chainId') return '0x2105';
    throw new Error(`unexpected ${method}`);
  }),
  on: (e: string, fn: unknown) => listeners.set(e, (listeners.get(e) ?? new Set()).add(fn)),
  removeListener: (e: string, fn: unknown) => listeners.get(e)?.delete(fn),
};
const innerConnect = vi.fn(async () => ({ accounts: ['0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae'], chainId: 8453 }));
const innerDisconnect = vi.fn(async () => {});

vi.mock('@rainbow-me/rainbowkit/wallets', () => ({
  base: () => ({
    id: 'base',
    name: 'Base',
    createConnector: () => () => ({
      id: 'baseAccount',
      connect: innerConnect,
      disconnect: innerDisconnect,
      getProvider: async () => provider,
      getChainId: async () => Number(await provider.request({ method: 'eth_chainId' })),
      onAccountsChanged() {},
      onChainChanged() {},
      async onDisconnect() {},
    }),
  }),
}));

const { baseAccountWallet } = await import('../lib/wallet/baseAccountWallet');
const connector = () => {
  const c = (baseAccountWallet({ appName: 'Afterbook' }).createConnector({} as never) as unknown as (cfg: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>)({});
  return c;
};

describe('baseAccountWallet', () => {
  it('reconnects from the saved session with eth_accounts, never wallet_connect, and listens for changes', async () => {
    calls.length = 0;
    saved = ['0x9b3f205e43dc9fcc1cc2fe6d9dcd0357769a6bae'];
    const c = connector();
    const r = await c.connect.call(c, { isReconnecting: true });
    expect(r).toEqual({ accounts: ['0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae'], chainId: 8453 });
    expect(calls).not.toContain('wallet_connect');
    expect(innerConnect).not.toHaveBeenCalled();
    expect(listeners.get('accountsChanged')?.size).toBe(1);
    // A second reconnect replaces the listeners rather than adding more; disconnect removes them.
    await c.connect.call(c, { isReconnecting: true });
    expect(listeners.get('accountsChanged')?.size).toBe(1);
    await c.disconnect.call(c);
    expect(listeners.get('accountsChanged')?.size).toBe(0);
    expect(innerDisconnect).toHaveBeenCalled();
  });
  it('treats no saved session as not connected, without opening anything', async () => {
    calls.length = 0;
    saved = [];
    const c = connector();
    await expect(c.connect.call(c, { isReconnecting: true })).rejects.toThrow(/no saved session/);
    expect(calls).toEqual(['eth_accounts']);
  });
  it('leaves a real connect (a click on Base) to the original connector', async () => {
    const c = connector();
    await c.connect.call(c, { chainId: 8453 });
    expect(innerConnect).toHaveBeenCalledWith({ chainId: 8453 });
  });
});
