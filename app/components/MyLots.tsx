'use client';

import { useEffect, useRef, useState } from 'react';
import { createCoinbaseWalletSDK, type ProviderInterface } from '@coinbase/wallet-sdk';

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

interface SpotHolding {
  symbol: string;
  shares: number;
  usdValue: number;
}

interface LpHolding {
  symbol: string;
  usdcAmount: number;
  shares: number;
  usdValue: number;
}

interface MyLotsResponse {
  spot: SpotHolding[];
  lp: LpHolding[];
}

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const shares = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

// Observed in practice: Coinbase's relay can hang indefinitely after a real
// QR scan + approval on the phone — no resolve, no reject, nothing — which
// would otherwise leave the connect button stuck disabled forever with no
// way out except a page reload. This is what actually recovers the UI in
// that case; it's a safety net, not a real cancellation of anything.
const COINBASE_CONNECT_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('afterbook-timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type WalletKind = 'injected' | 'coinbase';

export function MyLots() {
  const [address, setAddress] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<WalletKind | null>(null);
  const [connecting, setConnecting] = useState<WalletKind | null>(null);
  const [lots, setLots] = useState<MyLotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts false on both server and first client render (window doesn't
  // exist during SSR) — set for real once mounted, just below.
  const [hasProvider, setHasProvider] = useState(false);

  // Coinbase Wallet SDK works with no extension installed at all — it falls
  // back to a QR-code / deep-link handoff to the Coinbase Wallet mobile app —
  // so it's created lazily on first use, independent of window.ethereum.
  const coinbaseProviderRef = useRef<ProviderInterface | null>(null);
  const getCoinbaseProvider = () => {
    if (!coinbaseProviderRef.current) {
      const sdk = createCoinbaseWalletSDK({
        appName: 'Afterbook',
        appLogoUrl: null, // falls back to this page's own favicon
        appChainIds: [8453],
        preference: { options: 'eoaOnly' },
      });
      const provider = sdk.getProvider();
      provider.on('accountsChanged', (accounts) => {
        if (accounts.length > 0) {
          setAddress(accounts[0]);
          setActiveWallet('coinbase');
        } else {
          setAddress(null);
          setActiveWallet(null);
        }
      });
      coinbaseProviderRef.current = provider;
    }
    return coinbaseProviderRef.current;
  };

  // Restore an already-authorized connection without prompting — standard
  // dapp UX, and harmless since eth_accounts never triggers a wallet popup.
  useEffect(() => {
    if (!window.ethereum) return;
    setHasProvider(true);
    window.ethereum.request({ method: 'eth_accounts' }).then((accounts) => {
      const list = accounts as string[];
      if (list.length > 0) {
        setAddress(list[0]);
        setActiveWallet('injected');
      }
    });

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts.length > 0) {
        setAddress(accounts[0]);
      } else {
        setAddress(null);
        setActiveWallet(null);
      }
    };
    window.ethereum.on('accountsChanged', handleAccountsChanged);
    return () => window.ethereum?.removeListener('accountsChanged', handleAccountsChanged);
  }, []);

  useEffect(() => {
    if (!address) {
      setLots(null);
      return;
    }
    let cancelled = false;
    setError(null);
    fetch(`/api/lots?address=${address}`)
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) {
          setError(json.error);
          return;
        }
        setLots(json);
      })
      .catch(() => {
        if (!cancelled) setError('lots unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  const connectInjected = async () => {
    if (!window.ethereum) return;
    setConnecting('injected');
    try {
      const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setActiveWallet('injected');
      }
    } catch {
      // user rejected the connection — nothing to do
    } finally {
      setConnecting(null);
    }
  };

  const connectCoinbase = async () => {
    setConnecting('coinbase');
    setError(null);
    try {
      const accounts = (await withTimeout(
        getCoinbaseProvider().request({ method: 'eth_requestAccounts' }),
        COINBASE_CONNECT_TIMEOUT_MS,
      )) as string[];
      if (accounts.length > 0) {
        setAddress(accounts[0]);
        setActiveWallet('coinbase');
      }
    } catch (err) {
      if (err instanceof Error && err.message === 'afterbook-timeout') {
        setError('Coinbase Wallet didn’t respond in time — try again, or use "Connect browser wallet" instead.');
      }
      // otherwise: user rejected, or closed the QR/deep-link popup — nothing to show
    } finally {
      setConnecting(null);
    }
  };

  const disconnect = () => {
    if (activeWallet === 'coinbase') {
      coinbaseProviderRef.current?.disconnect().catch(() => {});
    }
    setAddress(null);
    setActiveWallet(null);
    setLots(null);
  };

  return (
    <section className="panel">
      <h2>My Lots</h2>

      {!address ? (
        <>
          <p className="geo-note" style={{ marginTop: 0, marginBottom: 12 }}>
            Read-only — connecting only reveals your address so balances can be read. Never signs a transaction.
          </p>
          <div className="my-lots-connect-row">
            <button type="button" className="btn btn-secondary" onClick={connectCoinbase} disabled={connecting !== null}>
              {connecting === 'coinbase' ? 'Connecting…' : 'Connect Coinbase Wallet'}
            </button>
            {hasProvider && (
              <button type="button" className="btn btn-secondary" onClick={connectInjected} disabled={connecting !== null}>
                {connecting === 'injected' ? 'Connecting…' : 'Connect browser wallet'}
              </button>
            )}
          </div>
          {error && <p className="geo-note">{error}</p>}
        </>
      ) : (
        <>
          <div className="my-lots-header">
            <span className="my-lots-address">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            <button type="button" className="copy-trade-btn" onClick={disconnect}>
              Disconnect
            </button>
          </div>

          {error && <p className="geo-note">{error}</p>}

          {lots && lots.spot.length === 0 && lots.lp.length === 0 && !error && (
            <p className="geo-note">No holdings found across these ten stocks or their Aero pools.</p>
          )}

          {lots && lots.spot.length > 0 && (
            <>
              <p className="geo-note" style={{ marginTop: 0 }}>
                Spot
              </p>
              <div className="result-grid">
                {lots.spot.map((h) => (
                  <div className="result-cell" key={h.symbol}>
                    <div className="label">{h.symbol}</div>
                    <div className="value">{shares(h.shares)} sh</div>
                    <div className="my-lots-usd">{usd(h.usdValue)}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {lots && lots.lp.length > 0 && (
            <>
              <p className="geo-note">Aerodrome LP</p>
              <div className="result-grid">
                {lots.lp.map((h) => (
                  <div className="result-cell" key={h.symbol}>
                    <div className="label">{h.symbol}</div>
                    <div className="value">
                      {usd(h.usdcAmount)} + {shares(h.shares)} sh
                    </div>
                    <div className="my-lots-usd">{usd(h.usdValue)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
