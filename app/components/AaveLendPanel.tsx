'use client';

import { useState } from 'react';
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, formatUnits, getAddress, type ContractFunctionParameters } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/wallet/builderCode';
import {
  AAVE_EQUITIES_HUB,
  AAVE_MAG7_SPOKE,
  HUB_ABI,
  lendWithdrawArg,
  MAX_LEND_USD,
  MAX_UINT256,
  maxLendWithdrawRaw,
  SPOKE_ABI,
  type AaveReserve,
} from '@/lib/lending/aaveBorrow';
import { WalletConnectButton } from './WalletConnectButton';
import { fmt, usd } from './swapClient';
import { useNotify } from './notify';
import { parseAmount, useSwapWallet, useTxRun } from './useSwapWallet';

// Lend USDC into Aave V4's Equities pool through the MAG7 spoke, from the visitor's own wallet (real
// money; lib/lending/aaveBorrow.ts has the verified contract facts). Two actions:
// - Deposit: an exact approval of the spoke (skipped if it already covers it), then supply(USDC).
//   At most $25k per deposit.
// - Withdraw: take USDC back, at most what the pool has free right now.
// Every call is on behalf of the signer and carries the Builder Code. The USDC reserve's token, decimals,
// hub and asset id are checked against what the page expects, and a paused or frozen reserve stops it.
// The one spoke approval call site is approveSpoke below: spender only AAVE_MAG7_SPOKE, exact amount.

export interface AaveLendProps {
  usdc: AaveReserve;
  /** USDC's asset id on the Equities Hub. */
  usdcAssetId: number;
  /** What lenders earn now (APR, before incentive programs) and how much of the pool is lent out. */
  supplyApr: number;
  utilization: number;
}

type Tab = 'deposit' | 'withdraw';
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ZERO = BigInt(0);

export function AaveLendPanel({ usdc, usdcAssetId, supplyApr, utilization }: AaveLendProps) {
  const { address } = useAccount();
  const { notify } = useNotify();
  const wallet = useSwapWallet();
  const publicClient = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const { busy, setBusy, error, run } = useTxRun({
    declined: 'Declined in your wallet. That step was not submitted.',
    declinedTitle: 'Declined',
    declinedBody: 'That step was not submitted.',
    failedTitle: 'Lending stopped',
  });

  const [tab, setTab] = useState<Tab>('deposit');
  const [depositText, setDepositText] = useState('');
  const [withdrawText, setWithdrawText] = useState('');
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);

  const acct = address ?? '0x0000000000000000000000000000000000000000';
  const spoke = { address: AAVE_MAG7_SPOKE, abi: SPOKE_ABI, chainId: base.id } as const;
  const id = BigInt(usdc.reserveId);
  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      { ...spoke, functionName: 'getReserve', args: [id] },
      { ...spoke, functionName: 'getReserveConfig', args: [id] },
      { ...spoke, functionName: 'getUserReserveStatus', args: [id, acct] },
      { ...spoke, functionName: 'getUserSuppliedAssets', args: [id, acct] },
      { address: usdc.token, abi: erc20Abi, functionName: 'balanceOf', args: [acct], chainId: base.id },
      { address: usdc.token, abi: erc20Abi, functionName: 'allowance', args: [acct, AAVE_MAG7_SPOKE], chainId: base.id },
      { address: AAVE_EQUITIES_HUB, abi: HUB_ABI, functionName: 'getAssetLiquidity', args: [BigInt(usdcAssetId)], chainId: base.id },
      // Mixed ABIs: results are decoded and checked by position below.
    ] as unknown as readonly ContractFunctionParameters[],
    query: { enabled: !!address },
  });

  // Decode the reads; any failure or mismatch leaves every action disabled.
  const state = (() => {
    if (!data || data.some((d) => d.status !== 'success')) return null;
    const r = data.map((d) => d.result as unknown);
    const reserve = r[0] as { underlying: string; hub: string; assetId: number; decimals: number };
    if (getAddress(reserve.underlying) !== getAddress(usdc.token) || reserve.decimals !== 6) return { mismatch: 'the USDC reserve changed' } as const;
    if (getAddress(reserve.hub) !== getAddress(AAVE_EQUITIES_HUB) || Number(reserve.assetId) !== usdcAssetId) return { mismatch: 'the USDC reserve now points at a different pool' } as const;
    const cfg = r[1] as { paused: boolean; frozen: boolean };
    if (cfg.paused) return { mismatch: 'Aave has paused the USDC reserve' } as const;
    // USDC switched on as collateral (only possible elsewhere, e.g. Aave's app) ties withdrawals to the
    // wallet's loan health, which this panel does not model.
    const [usdcAsCollateral] = r[2] as readonly [boolean, boolean];
    if (usdcAsCollateral) return { mismatch: "this wallet has USDC turned on as collateral on Aave, so withdrawals depend on its loan; manage it in Aave's own app" } as const;
    return {
      mismatch: null,
      frozen: cfg.frozen,
      supplied: r[3] as bigint,
      balance: r[4] as bigint,
      allowance: r[5] as bigint,
      liquidity: r[6] as bigint,
    };
  })();
  /** Re-read just before the first wallet call: the numbers on screen may be minutes old. */
  const fresh = async () => {
    const res = await refetch();
    const d = res.data;
    if (!d || d.some((x) => x.status !== 'success')) throw new Error('Could not re-read your Aave deposit. Nothing was sent.');
    const v = d.map((x) => x.result as unknown);
    return { supplied: v[3] as bigint, balance: v[4] as bigint, allowance: v[5] as bigint, liquidity: v[6] as bigint };
  };

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet on Base to lend USDC here.</p>
        <WalletConnectButton />
      </>
    );
  }
  if (isLoading || !state) return <p className="geo-note">{isLoading ? 'Reading your Aave deposit…' : 'Could not read your Aave deposit right now. Try again in a moment.'}</p>;
  if (state.mismatch) return <p className="geo-note geo-note-blocked">Lending here is paused: {state.mismatch}. Nothing was sent.</p>;

  const { frozen, supplied, balance, liquidity } = state;
  const withdrawLimit = maxLendWithdrawRaw(supplied, liquidity);
  const depositRaw = tab === 'deposit' ? parseAmount(depositText, 6) ?? ZERO : ZERO;
  const withdrawRaw = tab === 'withdraw' ? parseAmount(withdrawText, 6) ?? ZERO : ZERO;
  const maxDeposit = (() => {
    const cap = BigInt(MAX_LEND_USD) * BigInt(1e6);
    return balance < cap ? balance : cap;
  })();

  const problem = (() => {
    if (tab === 'deposit') {
      if (frozen) return 'Aave has frozen new deposits into this pool. Withdrawals still work.';
      if (depositRaw === ZERO) return null;
      if (depositRaw > balance) return 'Your wallet does not hold that much USDC on Base.';
      if (depositRaw > BigInt(MAX_LEND_USD) * BigInt(1e6)) return `Up to $${MAX_LEND_USD.toLocaleString('en-US')} per deposit here.`;
    }
    if (tab === 'withdraw') {
      if (withdrawRaw === ZERO) return null;
      if (withdrawRaw > supplied) return 'That is more than you have deposited.';
      if (withdrawRaw > liquidity) return `The pool has only ${fmt(liquidity, 6, 2)} USDC free right now (the rest is lent out). Try less, or later.`;
    }
    return null;
  })();
  const changed = depositRaw > ZERO || withdrawRaw > ZERO;

  // ---- wallet steps
  const waitOk = async (hash: `0x${string}`, reverted: string) => {
    if (!publicClient) throw new Error('Base is not reachable right now. Try again in a moment.');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(reverted);
  };
  /** Exactly `amount` USDC for the Aave spoke (the contract that pulls it), never unlimited. */
  const approveSpoke = async (amount: bigint) => {
    setBusy('approve');
    const hash = await writeContractAsync({ address: usdc.token, abi: erc20Abi, functionName: 'approve', args: [AAVE_MAG7_SPOKE, amount], chainId: base.id, dataSuffix: BUILDER_CODE_SUFFIX });
    setBusy('confirming');
    await waitOk(hash, 'The USDC approval reverted onchain. Nothing else was sent.');
  };
  const finish = async (hash: `0x${string}`, text: string, title: string) => {
    setDone({ hash, text });
    notify({ kind: 'tx', tone: 'success', title, body: text });
    setDepositText('');
    setWithdrawText('');
    await refetch();
  };

  const doDeposit = () =>
    run('start', async () => {
      setDone(null);
      await wallet.ensureBase();
      const now = await fresh();
      if (depositRaw > now.balance) throw new Error('Your wallet no longer holds that much USDC on Base. Nothing was sent.');
      if (now.allowance < depositRaw) await approveSpoke(depositRaw);
      setBusy('sign');
      const hash = await writeContractAsync({ ...spoke, functionName: 'supply', args: [id, depositRaw, address], dataSuffix: BUILDER_CODE_SUFFIX });
      setBusy('confirming');
      await waitOk(hash, 'The deposit reverted onchain. Nothing changed.');
      await finish(hash, `You lent ${fmt(depositRaw, 6, 2)} USDC to Aave's Equities pool.`, 'Deposited');
    });

  const doWithdraw = () =>
    run('start', async () => {
      setDone(null);
      await wallet.ensureBase();
      const now = await fresh();
      // "Max" typed from the earlier read: a full withdrawal stays full (MAX also takes interest since then).
      const amount = withdrawRaw >= supplied ? now.supplied : withdrawRaw;
      if (amount > now.liquidity) throw new Error(`The pool now has only ${fmt(now.liquidity, 6, 2)} USDC free. Nothing was sent; try less.`);
      const arg = lendWithdrawArg(amount, now.supplied, now.liquidity);
      setBusy('sign');
      const hash = await writeContractAsync({ ...spoke, functionName: 'withdraw', args: [id, arg, address], dataSuffix: BUILDER_CODE_SUFFIX });
      setBusy('confirming');
      await waitOk(hash, 'The withdrawal reverted onchain (borrowers may have drawn the pool down meanwhile). Nothing changed.');
      await finish(hash, arg === MAX_UINT256 ? `You withdrew everything you lent, about ${fmt(amount, 6, 2)} USDC with interest.` : `You withdrew ${fmt(amount, 6, 2)} USDC.`, 'Withdrawn');
    });

  const busyLabel = busy === 'approve' ? 'Approve USDC in wallet…' : busy === 'sign' ? 'Confirm in wallet…' : busy === 'confirming' ? 'Confirming onchain…' : busy ? 'Preparing…' : null;
  const amountInput = (value: string, set: (v: string) => void, label: string) => (
    <input
      inputMode="decimal"
      aria-label={label}
      placeholder={label}
      className="basket-amount"
      value={value}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9.]/g, '');
        if (/^\d*\.?\d{0,6}$/.test(v)) set(v);
      }}
      disabled={busy !== null}
    />
  );
  const yearly = (Number(supplied) / 1e6) * supplyApr;

  return (
    <div className="swap-panel">
      <div className="swap-review" style={{ marginTop: 0 }}>
        <dl>
          <dt>You lent</dt>
          <dd>
            {supplied > ZERO ? `${fmt(supplied, 6, 2)} USDC, interest included` : 'nothing yet'}
            {supplied > ZERO && yearly >= 0.01 && ` · about ${usd(yearly)} a year at today's rate`}
          </dd>
          <dt>Lenders earn</dt>
          <dd>about {pct(supplyApr)} a year, variable · {pct(utilization)} of the pool is lent out</dd>
          <dt>Free to withdraw</dt>
          <dd>{fmt(liquidity, 6, 0)} USDC in the pool now</dd>
        </dl>
      </div>

      <div className="carry-direction-toggle swap-side-toggle" role="tablist" aria-label="Lending action">
        {(['deposit', 'withdraw'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => setTab(t)}
            disabled={busy !== null || (t === 'withdraw' && supplied === ZERO)}
          >
            {t === 'deposit' ? 'Deposit' : 'Withdraw'}
          </button>
        ))}
      </div>

      {tab === 'deposit' && (
        <>
          <p className="geo-note">Wallet {fmt(balance, 6, 2)} USDC · up to ${MAX_LEND_USD.toLocaleString('en-US')} per deposit</p>
          <div className="basket-row">
            {amountInput(depositText, setDepositText, 'USDC to lend')}
            <button type="button" className="btn btn-secondary" onClick={() => setDepositText(formatUnits(maxDeposit, 6))} disabled={busy !== null || maxDeposit === ZERO}>
              Max
            </button>
          </div>
        </>
      )}

      {tab === 'withdraw' && (
        <>
          <p className="geo-note">
            Lent {fmt(supplied, 6, 2)} USDC · up to {fmt(withdrawLimit, 6, 2)} can come out now
          </p>
          <div className="basket-row">
            {amountInput(withdrawText, setWithdrawText, 'USDC to withdraw')}
            <button type="button" className="btn btn-secondary" onClick={() => setWithdrawText(formatUnits(withdrawLimit, 6))} disabled={busy !== null || withdrawLimit === ZERO}>
              Max
            </button>
          </div>
        </>
      )}

      {problem && <p className="geo-note geo-note-blocked">{problem}</p>}
      <div className="basket-row">
        <button type="button" className="btn" onClick={tab === 'deposit' ? doDeposit : doWithdraw} disabled={busy !== null || !changed || !!problem}>
          {busyLabel ?? (tab === 'deposit' ? 'Lend USDC' : 'Withdraw USDC')}
        </button>
      </div>
      <p className="geo-note">
        {tab === 'deposit'
          ? 'Your wallet asks to approve exactly this USDC (skipped if already approved), then the deposit. '
          : 'One transaction. '}
        The rate changes with how much is borrowed. Withdrawals can wait if borrowers have drawn most of the pool, and if a loan&apos;s
        stock can&apos;t be sold in time when its price falls (prices can stop updating while the stock market is closed), lenders can
        lose part of what they lent. You need a little ETH on Base for network fees.
      </p>
      {error && <p className="geo-note geo-note-blocked">{error}</p>}
      {done && (
        <p className="geo-note">
          {done.text}{' '}
          <a href={`https://basescan.org/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="emph-link">
            View transaction&nbsp;<span className="ext-arrow">↗</span>
          </a>
        </p>
      )}
    </div>
  );
}
