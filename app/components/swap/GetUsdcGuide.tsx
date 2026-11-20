'use client';

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { USDC } from '@/lib/stocks/tokens';

// "Get USDC on Base" (quest option E, 2026-11-20): new users with no USDC on Base were stuck at step one of every
// buy. Shown in the buy panels only when a connected wallet holds less USDC than it needs (open by itself at zero).
// Plain steps and the facts that trip people up (the network, the right USDC, gas), no third-party recommendations.

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** While shown, the balance is read again this often, so USDC sent from elsewhere shows up without a reload. */
const REFRESH_MS = 15_000;

export function GetUsdcGuide({ balance, needed, refetch }: { balance: bigint | undefined; needed?: bigint | null; refetch?: () => unknown }) {
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);
  const empty = balance === BigInt(0);
  const shown = !!address && balance !== undefined && (empty || (needed != null && needed > balance));
  useEffect(() => {
    if (!shown || !refetch) return;
    const id = setInterval(() => void refetch(), REFRESH_MS);
    return () => clearInterval(id);
  }, [shown, refetch]);
  if (!shown || !address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <details className="usdc-guide" open={empty}>
      <summary>{empty ? 'No USDC on Base yet? How to get some' : 'Need more USDC on Base? How to get some'}</summary>
      <div className="usdc-guide-body">
        <p className="usdc-guide-address">
          Your wallet on Base: <code className="usdc-guide-full">{address}</code>{' '}
          <button type="button" className="btn btn-secondary usdc-guide-copy" onClick={copy}>
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </p>
        <ol>
          <li>
            <strong>From an exchange account.</strong> Withdraw or send USDC to the address above and choose the{' '}
            <strong>Base</strong> network. USDC sent on another network won&apos;t arrive here and may be hard to recover.
          </li>
          <li>
            <strong>From ETH you already have on Base.</strong> Swap some of it for USDC in your wallet&apos;s own swap, and
            keep a little ETH for network fees.
          </li>
          <li>
            <strong>From another chain.</strong> Move USDC to Base with a bridge that supports Base, sending it to the
            address above.
          </li>
        </ol>
        <p>
          Check it&apos;s the right USDC: Afterbook uses Circle&apos;s USDC on Base,{' '}
          <a href={`https://basescan.org/token/${USDC.address}`} target="_blank" rel="noopener noreferrer" className="emph-link">
            {short(USDC.address)}&nbsp;<span className="ext-arrow">↗</span>
          </a>
          . Bridged USDbC is a different token and can&apos;t be used here. Your balance above updates by itself once it arrives.
        </p>
      </div>
    </details>
  );
}
