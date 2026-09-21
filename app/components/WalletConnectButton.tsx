'use client';

import { useAccount, useDisconnect } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';

const truncateAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

// A second, always-visible entry point into the same wallet connection
// My Lots manages (both read wagmi's global account state, so connecting
// from either stays in sync) — My Lots' own button requires scrolling
// down to find it first.
export function WalletConnectButton() {
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const { openConnectModal } = useConnectModal();

  // Same fix as My Lots' own disconnect: wagmi's disconnect() alone only
  // clears local state, not the wallet extension's own site permission —
  // wallet_revokePermissions is what makes the next Connect show a real
  // fresh picker instead of silently reusing this address.
  const handleDisconnect = () => {
    window.ethereum?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {});
    disconnect();
  };

  if (address) {
    return (
      <button
        type="button"
        className="wallet-connect-btn wallet-connect-btn-connected"
        onClick={handleDisconnect}
        title="Disconnect"
      >
        {truncateAddr(address)}
      </button>
    );
  }

  return (
    <button type="button" className="wallet-connect-btn" onClick={openConnectModal} disabled={!openConnectModal}>
      Connect wallet
    </button>
  );
}
