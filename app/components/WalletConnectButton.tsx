'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useDisconnect, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';
import { useConnectModal } from '@rainbow-me/rainbowkit';

const truncateAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

// One entry point into the wallet connection (header, My Lots, Baskets all read the
// same wagmi state). Connected, it opens a small account panel instead of
// disconnecting on click; on any network but Base it turns amber, because every
// read and transaction here is Base-only.
export function WalletConnectButton() {
  const { address, chainId, connector } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const { openConnectModal } = useConnectModal();

  // wagmi's disconnect() alone only clears local state, not the wallet extension's
  // own site permission — wallet_revokePermissions is what makes the next Connect
  // show a real fresh picker instead of silently reusing this address.
  const handleDisconnect = () => {
    window.ethereum?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    disconnect();
  };

  return (
    <WalletButtonView
      address={address}
      chainId={chainId}
      connectorName={connector?.name}
      onConnect={openConnectModal}
      onDisconnect={handleDisconnect}
      onSwitch={() => switchChain({ chainId: base.id })}
      switching={switching}
      switchFailed={!!switchError}
    />
  );
}

export interface WalletButtonViewProps {
  address?: string;
  chainId?: number;
  connectorName?: string;
  onConnect?: () => void;
  onDisconnect: () => void;
  onSwitch: () => void;
  switching: boolean;
  switchFailed: boolean;
}

// Presentational half, so every state can be rendered with plain props (the wallet
// modal and a real connection can't be driven headlessly).
export function WalletButtonView({
  address,
  chainId,
  connectorName,
  onConnect,
  onDisconnect,
  onSwitch,
  switching,
  switchFailed,
}: WalletButtonViewProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleDisconnect = () => {
    onDisconnect();
    setOpen(false);
  };

  const copy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure context, permissions); the full address is shown in the panel to select.
    }
  };

  if (!address) {
    return (
      <button type="button" className="wallet-connect-btn" onClick={onConnect} disabled={!onConnect}>
        Connect wallet
      </button>
    );
  }

  // chainId is undefined while a connection is settling; only a known other chain is "wrong".
  const wrongNetwork = chainId !== undefined && chainId !== base.id;

  return (
    <div className="wallet-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`wallet-connect-btn wallet-connect-btn-connected${wrongNetwork ? ' wallet-connect-btn-wrong' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Wallet"
      >
        {wrongNetwork ? (
          'Wrong network'
        ) : (
          <>
            {truncateAddr(address)}
            <span className="wallet-chain">Base</span>
          </>
        )}
      </button>

      {open && (
        <div className="wallet-panel" role="dialog" aria-label="Wallet">
          <div className="bell-head">
            <span className="wallet-status">
              <span className="wallet-status-dot" aria-hidden="true" />
              Connected wallet
            </span>
            <button type="button" className="toast-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <div className="wallet-id">
            <div className="wallet-id-short">{truncateAddr(address)}</div>
            {connectorName && <div className="wallet-id-sub">{connectorName}</div>}
          </div>
          <div className="wallet-full">{address}</div>

          <div className="wallet-actions">
            <button type="button" className="wallet-action" onClick={copy}>
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <a className="wallet-action" href={`https://basescan.org/address/${address}`} target="_blank" rel="noopener noreferrer">
              Basescan ↗
            </a>
          </div>

          <div className="wallet-section">
            <div className="wallet-section-title">Network</div>
            {wrongNetwork ? (
              <>
                <p className="wallet-warn">
                  Your wallet is on another network. Afterbook reads and transacts on Base only.
                </p>
                <button
                  type="button"
                  className="wallet-switch"
                  disabled={switching}
                  onClick={onSwitch}
                >
                  {switching ? 'Check your wallet…' : 'Switch to Base'}
                </button>
                {switchFailed && <p className="wallet-warn">Couldn’t switch. Change the network in your wallet.</p>}
              </>
            ) : (
              <div className="wallet-net-ok">
                <span>Base</span>
                <span aria-hidden="true">✓</span>
              </div>
            )}
          </div>

          <button type="button" className="wallet-disconnect" onClick={handleDisconnect}>
            <span>Disconnect</span>
            <span className="wallet-disconnect-note">This site only</span>
          </button>
        </div>
      )}
    </div>
  );
}
