'use client';

import { useEffect, useState } from 'react';

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

export function MyLots() {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [lots, setLots] = useState<MyLotsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Starts false on both server and first client render (window doesn't
  // exist during SSR) — set for real once mounted, just below.
  const [hasProvider, setHasProvider] = useState(false);

  // Restore an already-authorized connection without prompting — standard
  // dapp UX, and harmless since eth_accounts never triggers a wallet popup.
  useEffect(() => {
    if (!window.ethereum) return;
    setHasProvider(true);
    window.ethereum.request({ method: 'eth_accounts' }).then((accounts) => {
      const list = accounts as string[];
      if (list.length > 0) setAddress(list[0]);
    });

    const handleAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      setAddress(accounts.length > 0 ? accounts[0] : null);
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

  const connect = async () => {
    if (!window.ethereum) return;
    setConnecting(true);
    try {
      const accounts = (await window.ethereum.request({ method: 'eth_requestAccounts' })) as string[];
      if (accounts.length > 0) setAddress(accounts[0]);
    } catch {
      // user rejected the connection — nothing to do
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = () => {
    setAddress(null);
    setLots(null);
  };

  return (
    <section className="panel">
      <h2>My Lots</h2>

      {!hasProvider ? (
        <p className="geo-note">No wallet extension detected — connect isn&apos;t available in this browser.</p>
      ) : !address ? (
        <>
          <p className="geo-note" style={{ marginTop: 0, marginBottom: 12 }}>
            Read-only — connecting only reveals your address so balances can be read. Never signs a transaction.
          </p>
          <button type="button" className="btn btn-secondary" onClick={connect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect wallet'}
          </button>
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
