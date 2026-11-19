// RainbowKit's Base Account wallet, with one fix: reconnecting on page load never opens a window.
//
// wagmi reconnects a remembered wallet on every page load by calling the connector's `connect` with
// `isReconnecting: true`. The Base Account connector in @wagmi/connectors 6.x (the last line for
// wagmi 2, which RainbowKit 2 needs) ignores that flag and sends `wallet_connect`, which the Base
// Account SDK can only answer in a Coinbase window. Opened without a click, the browser blocks it,
// so every reload showed "Afterbook wants to continue in Base Account → Try again" and then a fresh
// "Sign into Afterbook" (owner, 2026-11-19). @wagmi/connectors 8 (wagmi 3) reads `eth_accounts`
// instead when reconnecting, which the SDK answers from its saved session; this does the same.
// Remove it after moving to wagmi 3.
import type { Wallet } from '@rainbow-me/rainbowkit';
import { base as rainbowBaseWallet } from '@rainbow-me/rainbowkit/wallets';
import { getAddress } from 'viem';
import { createConnector } from 'wagmi';

type Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, fn: (...a: never[]) => void): void;
  removeListener(event: string, fn: (...a: never[]) => void): void;
};

/** Reconnects from the SDK's saved session: no session (or no accounts) is "not connected", never a window. */
export async function reconnectAccounts(provider: Pick<Provider, 'request'>): Promise<`0x${string}`[]> {
  const accounts = (await provider.request({ method: 'eth_accounts', params: [] })) as string[];
  if (!accounts?.length) throw new Error('Base Account: no saved session');
  return accounts.map((a) => getAddress(a));
}

export const baseAccountWallet = (params: { appName: string; appIcon?: string }): Wallet => {
  const wallet = rainbowBaseWallet(params);
  return {
    ...wallet,
    createConnector: (details) => {
      const inner = wallet.createConnector(details);
      return createConnector((config) => {
        const c = inner(config);
        // Listeners this reconnect path adds (the inner connect adds its own, in its closure).
        let added: { event: string; fn: (...a: never[]) => void }[] = [];
        const removeAdded = async (provider: Provider) => {
          for (const { event, fn } of added) provider.removeListener(event, fn);
          added = [];
        };
        return {
          ...c,
          async connect(args) {
            if (!(args as { isReconnecting?: boolean } | undefined)?.isReconnecting) return (await c.connect.call(this, args)) as never;
            const provider = (await this.getProvider()) as Provider;
            const accounts = await reconnectAccounts(provider);
            const chainId = await this.getChainId();
            await removeAdded(provider);
            const self = this as typeof c;
            added = [
              { event: 'accountsChanged', fn: self.onAccountsChanged.bind(this) as never },
              { event: 'chainChanged', fn: self.onChainChanged.bind(this) as never },
              { event: 'disconnect', fn: self.onDisconnect.bind(this) as never },
            ];
            for (const { event, fn } of added) provider.on(event, fn);
            return { accounts, chainId } as never;
          },
          async disconnect() {
            await removeAdded((await this.getProvider()) as Provider);
            return c.disconnect.call(this);
          },
          async onDisconnect(error) {
            await removeAdded((await this.getProvider()) as Provider);
            return c.onDisconnect.call(this, error);
          },
        };
      });
    },
  };
};
