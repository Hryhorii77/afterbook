'use client';

import { useAccount, useReadContracts } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi } from 'viem';
import { KYBER_ROUTER } from '@/lib/swap/swap';
import { STOCKS, USDC } from '@/lib/stocks/tokens';
import { fmt } from './swapClient';
import { useNotify } from './notify';
import { useSwapWallet, useTxRun } from './useSwapWallet';

// Portfolio: what KyberSwap's router (the only contract Afterbook's swaps approve) may still spend
// from the connected wallet, for USDC and every tracked stock token, with a Revoke button that sets
// it back to zero. An allowance is left over when a basket run stops between its approval and its
// swaps, or when the wallet approved the router elsewhere (KyberSwap's own site uses the same one).
// Reads are one multicall; Revoke is approve(router, 0), with the Builder Code like every transaction.

const TOKENS: { symbol: string; address: `0x${string}`; decimals: number }[] = [
  { symbol: 'USDC', address: USDC.address, decimals: USDC.decimals },
  ...STOCKS.map((s) => ({ symbol: s.symbol, address: s.tokenAddress, decimals: s.decimals })),
];

/** At or above this an allowance is "unlimited" (2^255: wallets and sites approve 2^256 − 1). */
const UNLIMITED = BigInt(2) ** BigInt(255);

export function RouterApprovals() {
  const { address } = useAccount();
  const { notify } = useNotify();
  const wallet = useSwapWallet();
  const { busy, setBusy, error, run } = useTxRun({
    declined: 'Declined in your wallet. The approval was not changed.',
    declinedTitle: 'Revoke declined',
    declinedBody: 'The approval was not changed.',
    failedTitle: 'Revoke failed',
  });

  const { data, isLoading, isError, refetch } = useReadContracts({
    contracts: TOKENS.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'allowance', args: [address!, KYBER_ROUTER], chainId: base.id }) as const),
    query: { enabled: !!address },
  });

  if (!address) return null;

  const open = TOKENS.map((t, i) => ({ ...t, amount: (data?.[i]?.result as bigint | undefined) ?? BigInt(0) })).filter((t) => t.amount > BigInt(0));
  const failedReads = data?.filter((d) => d.status === 'failure').length ?? 0;

  const revoke = (t: (typeof open)[number]) =>
    run(`revoke-${t.symbol}`, async () => {
      await wallet.revokeRouter(t.address, `The ${t.symbol} revoke reverted onchain. The approval was not changed.`, () => setBusy(`confirm-${t.symbol}`));
      await refetch();
      // The node answering the read may be a block behind the revoke: read once more shortly after.
      setTimeout(() => void refetch(), 4000);
      notify({ kind: 'tx', tone: 'success', title: `${t.symbol} approval revoked`, body: 'The router can no longer spend it from your wallet.' });
    });

  return (
    <section className="panel" id="approvals">
      <h2>Approvals</h2>
      <p className="geo-note" style={{ marginTop: 0 }}>
        What KyberSwap&apos;s router, the contract Afterbook&apos;s swaps go through, may still spend from this wallet. A swap here approves exactly its own
        amount and uses it up; something is left only if a run stopped part way, or if you approved the router somewhere else.
      </p>
      {isLoading ? (
        <p className="geo-note">Reading approvals…</p>
      ) : isError ? (
        <p className="geo-note">Could not read approvals right now. Try again in a moment.</p>
      ) : open.length === 0 && failedReads === 0 ? (
        <p className="geo-note">None: the router cannot spend USDC or any tracked stock token from this wallet.</p>
      ) : open.length === 0 ? null : (
        <ul className="approval-list">
          {open.map((t) => (
            <li key={t.symbol} className="approval-row">
              <span className="approval-text">
                <strong>{t.symbol}</strong> {t.amount >= UNLIMITED ? 'unlimited' : `up to ${fmt(t.amount, t.decimals, t.decimals)}`}
              </span>
              <button type="button" className="btn btn-secondary" onClick={() => revoke(t)} disabled={busy !== null}>
                {busy === `revoke-${t.symbol}` ? 'Confirm in wallet…' : busy === `confirm-${t.symbol}` ? 'Confirming onchain…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!isLoading && !isError && failedReads > 0 && (
        // A failed read is not a zero: never claim "none" for a token we could not read.
        <div className="basket-row">
          <p className="geo-note" style={{ margin: 0, alignSelf: 'center' }}>
            Could not read {failedReads} of {TOKENS.length} tokens, so this list may be incomplete.
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => void refetch()} disabled={busy !== null}>
            Read again
          </button>
        </div>
      )}
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
      <p className="geo-note">
        Router{' '}
        <a href={`https://basescan.org/address/${KYBER_ROUTER}`} target="_blank" rel="noopener noreferrer" className="emph-link">
          {KYBER_ROUTER.slice(0, 6)}…{KYBER_ROUTER.slice(-4)}&nbsp;<span className="ext-arrow">↗</span>
        </a>
        . Revoking asks your wallet to sign one approval of zero (a small network fee in ETH). Approvals you gave other contracts are not listed.
      </p>
    </section>
  );
}
