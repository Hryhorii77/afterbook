'use client';

import { useEffect, useRef, useState } from 'react';
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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const addressRef = useRef<HTMLElement>(null);
  // The "Copied" reset timer: one at a time, cleared on a second click and on unmount.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);
  const empty = balance === BigInt(0);
  const shown = !!address && balance !== undefined && (empty || (needed != null && needed > balance));
  useEffect(() => {
    if (!shown || !refetch) return;
    // Skipped while the tab is in the background; the data library's default refetch when the tab is visible again
    // catches up when it returns.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refetch();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [shown, refetch]);
  if (!shown || !address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopyState('copied');
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      // Some in-wallet browsers block the clipboard: select the address so it can be copied by hand. A pending reset
      // from an earlier copy must not wipe this message.
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      setCopyState('failed');
      const el = addressRef.current;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  };

  return (
    <details className="usdc-guide" open={empty}>
      <summary>{empty ? 'No USDC on Base yet? How to get some' : 'Need more USDC on Base? How to get some'}</summary>
      <div className="usdc-guide-body">
        <p className="usdc-guide-address">
          Your wallet on Base:{' '}
          <code className="usdc-guide-full" ref={addressRef}>
            {address}
          </code>{' '}
          <button type="button" className="btn btn-secondary usdc-guide-copy" onClick={copy}>
            Copy address
          </button>
          <span className="usdc-guide-copied" aria-live="polite">
            {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Couldn\u2019t copy here: the address is selected, copy it by hand.' : ''}
          </span>
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
        <p>
          <strong>Network fees.</strong> A buy also needs a little ETH on Base for network fees, unless your wallet pays
          them in USDC (Base Account does: leave a few cents of USDC). If you only have USDC, get a few dollars of ETH on Base the same way.
        </p>
      </div>
    </details>
  );
}
