'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useReadContract, useSignMessage, useSignTypedData, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, formatUnits, parseUnits, type Hex } from 'viem';
import { USDC } from '@/lib/tokens';
import { WalletConnectButton } from './WalletConnectButton';
import { useNotify } from './notify';

interface Portfolio {
  portfolioId: string;
  smartAccounts: { accountId: string; depositAccountId?: string }[];
  schedule: { status: 'active' | 'paused'; nextDueAt?: string };
}
interface PositionAsset {
  assetId: string;
  symbol: string;
  balance: string;
  balanceRaw: string;
  valueUsd: string;
}
interface Positions {
  totalValueUsd: string;
  assets: PositionAsset[];
  warnings?: { kind: string; message: string }[];
}
interface EnrollStage1 {
  flowId: string;
  accountIndex: string;
  agentAccountId: string;
  message: { kind: 'ecdsa'; raw: Hex };
}

const BASE_PREFIX = 'eip155:8453:';

async function api<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init ? { 'content-type': 'application/json' } : undefined,
    body: init ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json as T;
}

const usd = (s: string) => `$${Number(s).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function BasketPanel() {
  const { address } = useAccount();
  const { notify } = useNotify();
  const { signMessageAsync } = useSignMessage();
  const { signTypedDataAsync } = useSignTypedData();

  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [positions, setPositions] = useState<Positions | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [review, setReview] = useState<EnrollStage1 | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [ack, setAck] = useState(false);
  const { writeContractAsync } = useWriteContract();

  const { data: usdcBalance, refetch: refetchUsdc } = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: !!address },
  });

  const refresh = useCallback(async () => {
    if (!address) return;
    void refetchUsdc();
    try {
      const data = await api<{ portfolio: Portfolio | null; positions: Positions | null }>(`/api/baskets/portfolio?owner=${address}`);
      setPortfolio(data.portfolio);
      setPositions(data.positions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [address, refetchUsdc]);

  useEffect(() => {
    setPortfolio(null);
    setPositions(null);
    setReview(null);
    setLoaded(false);
    setError(null);
    setNotice(null);
    void refresh();
  }, [refresh]);

  // Amount in USDC base units, or null while the field is empty / not a number.
  const amountUnits = (() => {
    if (!/^\d*\.?\d+$/.test(amount)) return null;
    try {
      return parseUnits(amount, USDC.decimals);
    } catch {
      return null;
    }
  })();
  const overBalance = amountUnits !== null && usdcBalance !== undefined && amountUnits > usdcBalance;
  const canSend = amountUnits !== null && amountUnits > BigInt(0) && !overBalance;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      // Wallet rejections surface here too — say so plainly rather than as a fault.
      const msg = (e as Error).message ?? 'failed';
      const declined = /reject|denied/i.test(msg);
      setError(declined ? 'Signature declined in your wallet — nothing was submitted.' : msg);
      const what: Record<string, string> = { review: 'Could not prepare enrollment', enroll: 'Enrollment failed', deposit: 'Deposit failed', start: 'Could not start automation', withdraw: 'Withdrawal failed' };
      notify(declined
        ? { kind: 'tx', tone: 'info', title: 'Signature declined', body: 'Nothing was submitted.' }
        : { kind: 'tx', tone: 'error', title: what[label] ?? 'Something went wrong', body: msg });
    } finally {
      setBusy(null);
    }
  };

  // Stage 1: fetch what would be signed and show it BEFORE asking the wallet.
  const startEnroll = () =>
    run('review', async () => {
      setReview(await api<EnrollStage1>('/api/baskets/enroll/signature', { method: 'POST', body: { owner: address } }));
    });

  // Stage 2: sign the unchanged message, submit with the round-trip fields untouched.
  const confirmEnroll = () =>
    run('enroll', async () => {
      if (!review) return;
      const signature = await signMessageAsync({ message: { raw: review.message.raw } });
      await api('/api/baskets/enroll', {
        method: 'POST',
        body: {
          owner: address,
          flowId: review.flowId,
          accountIndex: review.accountIndex,
          agentAccountId: review.agentAccountId,
          signature,
          portfolioName: 'Afterbook Basis Tilt',
        },
      });
      setReview(null);
      setNotice('Enrolled. Automation is on — send funds to the deposit address below and the first rebalance will allocate them.');
      notify({ kind: 'tx', tone: 'success', title: 'Enrolled in Basis Tilt', body: 'Send USDC to your deposit address to get started.' });
      await refresh();
    });

  const startAutomation = () =>
    run('start', async () => {
      await api('/api/baskets/start', { method: 'POST', body: { owner: address } });
      setNotice('Automation started.');
      await refresh();
    });

  // A plain ERC-20 transfer from the user's own wallet to their own Glider
  // smart account — the wallet shows the exact recipient and amount, and this
  // app never holds the funds. Recipient is re-derived from Glider's portfolio
  // response, not from anything the user typed.
  const sendUsdc = (to: string) =>
    run('deposit', async () => {
      const value = parseUnits(amount, USDC.decimals);
      if (value <= BigInt(0)) throw new Error('Enter an amount above zero.');
      if (usdcBalance !== undefined && value > usdcBalance) throw new Error('That is more USDC than your wallet holds on Base.');
      await writeContractAsync({ address: USDC.address, abi: erc20Abi, functionName: 'transfer', args: [to as Hex, value], chainId: base.id });
      setAmount('');
      setNotice('USDC sent. It should appear in your balance after the transaction confirms and Glider picks it up — press Refresh.');
      notify({ kind: 'tx', tone: 'success', title: 'USDC sent', body: 'It will show in your balance once the transaction confirms.' });
      void refetchUsdc();
      setTimeout(() => void refresh(), 10000);
    });

  const withdrawAll = (liquidate: boolean) =>
    run('withdraw', async () => {
      const assets = (positions?.assets ?? []).filter((a) => a.balanceRaw !== '0' && a.assetId.startsWith('eip155:8453/'));
      if (assets.length === 0) throw new Error('Nothing to withdraw yet.');
      const sig = await api<{ typedData: { domain: object; types: Record<string, unknown>; primaryType: string; message: unknown } }>(
        '/api/baskets/withdraw/signature',
        { method: 'POST', body: { owner: address, liquidate, assets: assets.map((a) => ({ assetId: a.assetId, amountRaw: a.balanceRaw })) } },
      );
      const { domain, types, primaryType, message } = sig.typedData;
      const signature = await signTypedDataAsync({ domain, types, primaryType, message } as Parameters<typeof signTypedDataAsync>[0]);
      const { operationId } = await api<{ operationId: string }>('/api/baskets/withdraw', {
        method: 'POST',
        body: { owner: address, message, signature },
      });
      setNotice('Withdrawal submitted — waiting for it to settle…');
      notify({ kind: 'tx', tone: 'info', title: 'Withdrawal submitted', body: 'Waiting for it to settle.' });
      // Poll Glider's operation until it reaches a terminal state (every 3s,
      // up to ~2 min), then re-read balances instead of guessing with a timer.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        let op: { state: string; error: string | null };
        try {
          op = await api(`/api/baskets/operation?owner=${address}&operationId=${encodeURIComponent(operationId)}`);
        } catch {
          // The withdrawal itself was already accepted; only the status check
          // failed. Say that instead of showing an error that reads like a failed withdrawal.
          setNotice('Withdrawal submitted, but its status could not be read. Press Refresh to see your balance.');
          await refresh();
          return;
        }
        if (op.state === 'completed') {
          setNotice('Withdrawal complete — the funds are in your wallet.');
          notify({ kind: 'tx', tone: 'success', title: 'Withdrawal complete', body: 'The funds are in your wallet.' });
          await refresh();
          return;
        }
        if (op.state === 'failed' || op.state === 'cancelled') {
          throw new Error(`Withdrawal ${op.state}${op.error ? `: ${op.error}` : ''}. Your funds stay in your Basis Tilt account.`);
        }
      }
      setNotice('Still processing — press Refresh in a minute to check.');
      await refresh();
    });

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet to enroll in Basis Tilt.</p>
        <WalletConnectButton />
      </>
    );
  }
  if (!loaded) return <p className="geo-note" style={{ marginTop: 0 }}>Checking your portfolio…</p>;

  const deposit = portfolio?.smartAccounts.find((a) => a.accountId.startsWith(BASE_PREFIX));
  const depositAddr = (deposit?.depositAccountId ?? deposit?.accountId)?.split(':')[2];
  const withdrawable = (positions?.assets ?? []).some((a) => a.balanceRaw !== '0');

  return (
    <>
      {!portfolio && !review && (
        <>
          <p className="geo-note" style={{ marginTop: 0 }}>
            Enrolling creates a smart account on Base that only you can withdraw from. Afterbook never holds funds.
          </p>
          <label className="geo-note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 12 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              I have read the{' '}
              <a href="/baskets/risks" target="_blank" rel="noopener noreferrer" className="emph-link">
                risks and terms
              </a>
              , including that I can lose money, and that this is not available to people in the US.
            </span>
          </label>
          <button type="button" className="btn" onClick={startEnroll} disabled={busy !== null || !ack}>
            {busy === 'review' ? 'Preparing…' : 'Enroll in Basis Tilt'}
          </button>
        </>
      )}

      {!portfolio && review && (
        <>
          <p className="geo-note" style={{ marginTop: 0 }}>
            You are about to sign a message that authorizes Glider&apos;s automation agent to create a Base smart account
            owned by <code>{address}</code> and rebalance it to the Basis Tilt strategy. It does not move any funds. You can
            withdraw at any time with a fresh signature.
          </p>
          <p className="geo-note">
            Agent: <code>{review.agentAccountId}</code>
            <br />
            Message hash: <code>{review.message.raw}</code>
          </p>
          <div className="basket-row">
            <button type="button" className="btn" onClick={confirmEnroll} disabled={busy !== null}>
              {busy === 'enroll' ? 'Waiting for signature…' : 'Sign and enroll'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setReview(null)} disabled={busy !== null}>
              Cancel
            </button>
          </div>
        </>
      )}

      {portfolio && (
        <>
          <p className="geo-note" style={{ marginTop: 0 }}>
            Deposit address on Base: <code>{depositAddr ?? 'unavailable'}</code>
            <br />
            Only send assets on <strong>Base</strong> to this address. Funds sent on another network, or to the wrong
            address, may not be recoverable.
          </p>
          {depositAddr && (
            <div className="basket-deposit">
              <p className="geo-note" style={{ marginTop: 0 }}>
                Your wallet: {usdcBalance !== undefined ? `${formatUnits(usdcBalance, USDC.decimals)} USDC` : '…'} on Base
              </p>
              <div className="basket-row">
                <input
                  inputMode="decimal"
                  aria-label="USDC amount"
                  placeholder="USDC amount"
                  className="basket-amount"
                  value={amount}
                  onChange={(e) => {
                    const next = e.target.value.replace(/[^0-9.]/g, '');
                    // USDC has 6 decimals; refuse more rather than silently rounding the amount sent.
                    if (/^\d*\.?\d{0,6}$/.test(next)) setAmount(next);
                  }}
                  disabled={busy !== null}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => usdcBalance !== undefined && setAmount(formatUnits(usdcBalance, USDC.decimals))}
                  disabled={busy !== null || !usdcBalance}
                >
                  Max
                </button>
                <button type="button" className="btn" onClick={() => sendUsdc(depositAddr)} disabled={busy !== null || !canSend}>
                  {busy === 'deposit' ? 'Confirm in wallet…' : 'Send USDC'}
                </button>
              </div>
              {overBalance && (
                <p className="geo-note geo-note-blocked" style={{ marginTop: 0 }}>
                  That is more than the {formatUnits(usdcBalance ?? BigInt(0), USDC.decimals)} USDC in your wallet on Base.
                </p>
              )}
              <p className="geo-note" style={{ marginTop: 0 }}>
                Sends USDC from your wallet to your own Basis Tilt account on Base, then Glider spreads it across the
                basket. Each position needs at least $1 to trade, so tiny deposits may leave some names unfilled.
              </p>
            </div>
          )}
          {positions && (
            <p className="geo-note">
              Balance {usd(positions.totalValueUsd)} · automation {portfolio.schedule.status}
              {positions.assets.filter((a) => a.balanceRaw !== '0').map((a) => (
                <span key={a.assetId} style={{ display: 'block' }}>
                  {a.symbol} {a.balance} ({usd(a.valueUsd)})
                </span>
              ))}
              {positions.warnings?.map((w) => (
                <span key={w.kind + w.message} style={{ display: 'block' }}>
                  Note: {w.message}
                </span>
              ))}
            </p>
          )}
          <div className="basket-row">
            {portfolio.schedule.status === 'paused' && (
              <button type="button" className="btn" onClick={startAutomation} disabled={busy !== null || !withdrawable}>
                {busy === 'start' ? 'Starting…' : 'Start automation'}
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => withdrawAll(true)} disabled={busy !== null || !withdrawable}>
              {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw as USDC'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => withdrawAll(false)} disabled={busy !== null || !withdrawable}>
              Withdraw as tokens
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={busy !== null}>
              Refresh
            </button>
          </div>
        </>
      )}

      {notice && <p className="geo-note">{notice}</p>}
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
    </>
  );
}
