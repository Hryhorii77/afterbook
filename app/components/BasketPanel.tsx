'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAccount, useReadContract, useSignMessage, useSignTypedData, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, formatUnits, parseUnits, type Hex } from 'viem';
import { USDC } from '@/lib/tokens';
import { WalletConnectButton } from './WalletConnectButton';

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
    try {
      const data = await api<{ portfolio: Portfolio | null; positions: Positions | null }>(`/api/baskets/portfolio?owner=${address}`);
      setPortfolio(data.portfolio);
      setPositions(data.positions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [address]);

  useEffect(() => {
    setPortfolio(null);
    setPositions(null);
    setReview(null);
    setLoaded(false);
    setError(null);
    setNotice(null);
    void refresh();
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      // Wallet rejections surface here too — say so plainly rather than as a fault.
      const msg = (e as Error).message ?? 'failed';
      setError(/reject|denied/i.test(msg) ? 'Signature declined in your wallet — nothing was submitted.' : msg);
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
      void refetchUsdc();
      setTimeout(() => void refresh(), 10000);
    });

  const withdrawAll = () =>
    run('withdraw', async () => {
      const assets = (positions?.assets ?? []).filter((a) => a.balanceRaw !== '0' && a.assetId.startsWith('eip155:8453/'));
      if (assets.length === 0) throw new Error('Nothing to withdraw yet.');
      const sig = await api<{ typedData: { domain: object; types: Record<string, unknown>; primaryType: string; message: unknown } }>(
        '/api/baskets/withdraw/signature',
        { method: 'POST', body: { owner: address, assets: assets.map((a) => ({ assetId: a.assetId, amountRaw: a.balanceRaw })) } },
      );
      const { domain, types, primaryType, message } = sig.typedData;
      const signature = await signTypedDataAsync({ domain, types, primaryType, message } as Parameters<typeof signTypedDataAsync>[0]);
      await api('/api/baskets/withdraw', { method: 'POST', body: { owner: address, message, signature } });
      setNotice('Withdrawal submitted to your wallet address. It can take a minute to settle.');
      setTimeout(() => void refresh(), 8000);
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
          <button type="button" className="btn" onClick={startEnroll} disabled={busy !== null}>
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
          <button type="button" className="btn" onClick={confirmEnroll} disabled={busy !== null}>
            {busy === 'enroll' ? 'Waiting for signature…' : 'Sign and enroll'}
          </button>{' '}
          <button type="button" className="btn btn-secondary" onClick={() => setReview(null)} disabled={busy !== null}>
            Cancel
          </button>
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
            <p className="geo-note">
              Your wallet: {usdcBalance !== undefined ? `${formatUnits(usdcBalance, USDC.decimals)} USDC` : '…'} on Base
              <br />
              <input
                inputMode="decimal"
                placeholder="USDC amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                style={{ marginRight: 8, width: 140 }}
                disabled={busy !== null}
              />
              <button type="button" className="btn" onClick={() => sendUsdc(depositAddr)} disabled={busy !== null || !/^\d*\.?\d+$/.test(amount)}>
                {busy === 'deposit' ? 'Confirm in wallet…' : 'Send USDC'}
              </button>
              <br />
              Sends USDC from your wallet to your own Basis Tilt account on Base, then Glider spreads it across the basket.
              Each position needs at least $1 to trade, so tiny deposits may leave some names unfilled.
            </p>
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
          {portfolio.schedule.status === 'paused' && (
            <>
              <button type="button" className="btn" onClick={startAutomation} disabled={busy !== null || !withdrawable}>
                {busy === 'start' ? 'Starting…' : 'Start automation'}
              </button>{' '}
            </>
          )}
          <button type="button" className="btn btn-secondary" onClick={withdrawAll} disabled={busy !== null || !withdrawable}>
            {busy === 'withdraw' ? 'Waiting for signature…' : 'Withdraw everything'}
          </button>{' '}
          <button type="button" className="btn btn-secondary" onClick={() => void refresh()} disabled={busy !== null}>
            Refresh
          </button>
        </>
      )}

      {notice && <p className="geo-note">{notice}</p>}
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
    </>
  );
}
