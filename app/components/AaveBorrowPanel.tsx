'use client';

import { useState } from 'react';
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { erc20Abi, formatUnits, getAddress, type ContractFunctionParameters } from 'viem';
import { BUILDER_CODE_SUFFIX } from '@/lib/builderCode';
import {
  AAVE_MAG7_SPOKE,
  AAVE_ORACLE_ABI,
  AAVE_PRICE_DECIMALS,
  borrowCalls,
  fallToLiquidation,
  healthFactor,
  MAX_BORROW_USD,
  MAX_UINT256,
  maxBorrowRaw,
  maxWithdrawRaw,
  repayAllApproval,
  SPOKE_ABI,
  withChange,
  type AavePosition,
  type AaveReserve,
} from '@/lib/aaveBorrow';
import { WalletConnectButton } from './WalletConnectButton';
import { fmt, usd } from './swapClient';
import { useNotify } from './notify';
import { parseAmount, useSwapWallet, useTxRun } from './useSwapWallet';

// Borrow USDC against stock tokens on Aave V4's MAG7 spoke, from the visitor's own wallet (real
// money; lib/aaveBorrow.ts has the verified contract facts). Three actions:
// - Borrow: optionally add a stock as collateral (exact approval of the spoke, then one multicall:
//   supply, setUsingAsCollateral, borrow), up to the protocol limit less a small margin, $25k per action.
// - Repay: exact approval (or the debt plus 1 bp for "all"), then repay.
// - Withdraw: take collateral back while the loan stays within the limit.
// Every call is on behalf of the signer and carries the Builder Code. Before acting, each reserve's
// token and the oracle are checked against what the page expects; any mismatch stops everything.
// Spoke approvals have one call site, approveSpoke below: spender only AAVE_MAG7_SPOKE, exact amount.

export interface AaveBorrowProps {
  stocks: AaveReserve[];
  usdc: AaveReserve;
  oracle: `0x${string}`;
  /** USDC the pool can still lend (liquidity within the spoke's borrow cap). */
  poolLiquidityUsd: number;
  borrowApr: number;
}

type Tab = 'borrow' | 'repay' | 'withdraw';
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const hfText = (hf: number) => (Number.isFinite(hf) ? hf.toFixed(2) : 'no loan');

export function AaveBorrowPanel({ stocks, usdc, oracle, poolLiquidityUsd, borrowApr }: AaveBorrowProps) {
  const { address } = useAccount();
  const { notify } = useNotify();
  const wallet = useSwapWallet();
  const publicClient = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const { busy, setBusy, error, run } = useTxRun({
    declined: 'Declined in your wallet. That step was not submitted.',
    declinedTitle: 'Declined',
    declinedBody: 'That step was not submitted.',
    failedTitle: 'Loan action stopped',
  });

  const [tab, setTab] = useState<Tab>('borrow');
  const [symbol, setSymbol] = useState<string | null>(null);
  const [addText, setAddText] = useState('');
  const [borrowText, setBorrowText] = useState('');
  const [repayText, setRepayText] = useState('');
  const [repayAll, setRepayAll] = useState(false);
  const [withdrawText, setWithdrawText] = useState('');
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);

  const ids = [...stocks.map((s) => BigInt(s.reserveId)), BigInt(usdc.reserveId)];
  const acct = address ?? '0x0000000000000000000000000000000000000000';
  const spoke = { address: AAVE_MAG7_SPOKE, abi: SPOKE_ABI, chainId: base.id } as const;
  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      { ...spoke, functionName: 'ORACLE' },
      { address: oracle, abi: AAVE_ORACLE_ABI, functionName: 'getReservesPrices', args: [ids], chainId: base.id },
      { ...spoke, functionName: 'getReserve', args: [BigInt(usdc.reserveId)] },
      { ...spoke, functionName: 'getUserTotalDebt', args: [BigInt(usdc.reserveId), acct] },
      { ...spoke, functionName: 'getUserAccountData', args: [acct] },
      { address: usdc.token, abi: erc20Abi, functionName: 'balanceOf', args: [acct], chainId: base.id },
      { address: usdc.token, abi: erc20Abi, functionName: 'allowance', args: [acct, AAVE_MAG7_SPOKE], chainId: base.id },
      ...stocks.flatMap((s) => [
        { ...spoke, functionName: 'getReserve', args: [BigInt(s.reserveId)] },
        { ...spoke, functionName: 'getUserReserveStatus', args: [BigInt(s.reserveId), acct] },
        { ...spoke, functionName: 'getUserSuppliedAssets', args: [BigInt(s.reserveId), acct] },
        { address: s.token, abi: erc20Abi, functionName: 'balanceOf', args: [acct], chainId: base.id },
        { address: s.token, abi: erc20Abi, functionName: 'allowance', args: [acct, AAVE_MAG7_SPOKE], chainId: base.id },
      ]),
      // Mixed ABIs: results are decoded and checked by position below.
    ] as unknown as readonly ContractFunctionParameters[],
    query: { enabled: !!address },
  });

  // Decode the reads; any failure or mismatch leaves `state` null and every action disabled.
  const state = (() => {
    if (!data || data.some((d) => d.status !== 'success')) return null;
    const r = data.map((d) => d.result as unknown);
    if (getAddress(r[0] as string) !== getAddress(oracle)) return { mismatch: 'the spoke now uses a different price oracle' } as const;
    const prices = r[1] as readonly bigint[];
    const usdcReserve = r[2] as { underlying: string; decimals: number };
    if (getAddress(usdcReserve.underlying) !== getAddress(usdc.token) || usdcReserve.decimals !== 6) return { mismatch: 'the USDC reserve changed' } as const;
    const priceOf = (i: number) => Number(prices[i]) / 10 ** AAVE_PRICE_DECIMALS;
    if (Math.abs(priceOf(stocks.length) - 1) > 0.05) return { mismatch: 'the USDC price reads wrong' } as const;
    const perStock = stocks.map((s, i) => {
      const o = 7 + i * 5;
      const res = r[o] as { underlying: string; decimals: number };
      const [enabled] = r[o + 1] as readonly [boolean, boolean];
      return { s, ok: getAddress(res.underlying) === getAddress(s.token) && res.decimals === s.decimals, enabled, supplied: r[o + 2] as bigint, balance: r[o + 3] as bigint, allowance: r[o + 4] as bigint, priceUsd: priceOf(i) };
    });
    if (perStock.some((x) => !x.ok)) return { mismatch: 'a stock reserve changed' } as const;
    const account = r[4] as { healthFactor: bigint; borrowCount: bigint };
    // Debt in anything but USDC (opened in Aave's own app) is not modelled here: the limits would be wrong.
    const usdcBorrowing = (r[3] as bigint) > BigInt(0);
    if (account.borrowCount > (usdcBorrowing ? BigInt(1) : BigInt(0))) return { mismatch: 'this wallet also has a loan in another asset on this Aave spoke, which this panel does not handle' } as const;
    const position: AavePosition = {
      collateral: perStock.map((x) => ({ reserve: x.s, suppliedRaw: x.supplied, enabled: x.enabled, priceUsd: x.priceUsd })),
      debtRaw: r[3] as bigint,
      usdcPriceUsd: priceOf(stocks.length),
    };
    const chainHf = account.healthFactor >= MAX_UINT256 / BigInt(2) ? Infinity : Number(account.healthFactor) / 1e18;
    return { mismatch: null, perStock, position, chainHf, usdcBalance: r[5] as bigint, usdcAllowance: r[6] as bigint };
  })();

  if (!address) {
    return (
      <>
        <p className="geo-note" style={{ marginTop: 0 }}>Connect a wallet on Base to borrow against your stock tokens here.</p>
        <WalletConnectButton />
      </>
    );
  }
  if (isLoading || !state) return <p className="geo-note">{isLoading ? 'Reading your Aave position…' : 'Could not read your Aave position right now. Try again in a moment.'}</p>;
  if (state.mismatch) return <p className="geo-note geo-note-blocked">Borrowing here is paused: {state.mismatch}. Nothing was sent. Use Aave&apos;s own app meanwhile.</p>;

  const { perStock, position, chainHf, usdcBalance, usdcAllowance } = state;
  const held = perStock.filter((x) => x.supplied > BigInt(0));
  // The dropdown lists every stock to borrow against, but only posted ones to withdraw: the selection
  // always comes from the list on screen, so what is shown is what is acted on.
  const choices = tab === 'withdraw' && held.length > 0 ? held : perStock;
  // Until one is picked, start on a stock the wallet has posted or holds.
  const sel = choices.find((x) => x.s.symbol === symbol) ?? choices.find((x) => x.supplied > BigInt(0) || x.balance > BigInt(0)) ?? choices[0];
  const owes = position.debtRaw > BigInt(0);

  // ---- the change being typed, and the position it leads to
  const addRaw = tab === 'borrow' ? parseAmount(addText, sel.s.decimals) ?? BigInt(0) : BigInt(0);
  const borrowRaw = tab === 'borrow' ? parseAmount(borrowText, 6) ?? BigInt(0) : BigInt(0);
  const repayRaw = tab === 'repay' ? (repayAll ? position.debtRaw : parseAmount(repayText, 6) ?? BigInt(0)) : BigInt(0);
  const withdrawRaw = tab === 'withdraw' ? parseAmount(withdrawText, sel.s.decimals) ?? BigInt(0) : BigInt(0);
  const next = withChange(position, { reserveId: sel.s.reserveId, addRaw, borrowRaw, repayRaw, withdrawRaw });
  const borrowLimit = maxBorrowRaw(withChange(position, { reserveId: sel.s.reserveId, addRaw }), poolLiquidityUsd);
  const withdrawLimit = maxWithdrawRaw(position, sel.s.reserveId);

  const problem = (() => {
    if (tab === 'borrow') {
      if (addRaw === BigInt(0) && borrowRaw === BigInt(0)) return null;
      if (addRaw > sel.balance) return `That is more ${sel.s.symbol} than your wallet holds.`;
      if (borrowRaw > BigInt(MAX_BORROW_USD) * BigInt(1e6)) return `Up to $${MAX_BORROW_USD.toLocaleString('en-US')} per borrow here.`;
      if (borrowRaw > borrowLimit) return `Over what this collateral allows right now (at most ${fmt(borrowLimit, 6, 2)} USDC).`;
    }
    if (tab === 'repay') {
      if (repayRaw === BigInt(0)) return null;
      if (repayRaw > position.debtRaw && !repayAll) return 'That is more than you owe; use All.';
      if (repayRaw > usdcBalance) return 'Your wallet does not hold enough USDC on Base for that.';
    }
    if (tab === 'withdraw') {
      if (withdrawRaw === BigInt(0)) return null;
      if (withdrawRaw > withdrawLimit) return `At most ${fmt(withdrawLimit, sel.s.decimals)} ${sel.s.symbol} can come out while your loan stays within the limit.`;
    }
    return null;
  })();
  const changed = addRaw > BigInt(0) || borrowRaw > BigInt(0) || repayRaw > BigInt(0) || withdrawRaw > BigInt(0);
  const nextHf = healthFactor(next);
  const nextFall = fallToLiquidation(next);
  const nowFall = fallToLiquidation(position);

  // ---- wallet steps
  const waitOk = async (hash: `0x${string}`, reverted: string) => {
    if (!publicClient) throw new Error('Base is not reachable right now. Try again in a moment.');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(reverted);
  };
  /** Exactly `amount` of `token` for the Aave spoke (the contract that pulls it), never unlimited. */
  const approveSpoke = async (token: `0x${string}`, amount: bigint, sym: string) => {
    setBusy(`approve-${sym}`);
    const hash = await writeContractAsync({ address: token, abi: erc20Abi, functionName: 'approve', args: [AAVE_MAG7_SPOKE, amount], chainId: base.id, dataSuffix: BUILDER_CODE_SUFFIX });
    setBusy('confirming');
    await waitOk(hash, `The ${sym} approval reverted onchain. Nothing else was sent.`);
  };
  const finish = async (hash: `0x${string}`, text: string, title: string) => {
    setDone({ hash, text });
    notify({ kind: 'tx', tone: 'success', title, body: text });
    setAddText('');
    setBorrowText('');
    setRepayText('');
    setRepayAll(false);
    setWithdrawText('');
    await refetch();
  };

  const doBorrow = () =>
    run('start', async () => {
      setDone(null);
      await wallet.ensureBase();
      if (addRaw > BigInt(0) && sel.allowance < addRaw) await approveSpoke(sel.s.token, addRaw, sel.s.symbol);
      const calls = borrowCalls(address, { stock: sel.s, addRaw, enableCollateral: !sel.enabled, usdc, borrowRaw });
      setBusy('sign');
      const hash = await writeContractAsync({ ...spoke, functionName: 'multicall', args: [calls], dataSuffix: BUILDER_CODE_SUFFIX });
      setBusy('confirming');
      await waitOk(hash, 'The transaction reverted onchain (the price or the limit moved). Nothing changed.');
      const parts = [addRaw > BigInt(0) ? `added ${fmt(addRaw, sel.s.decimals)} ${sel.s.symbol} as collateral` : '', borrowRaw > BigInt(0) ? `borrowed ${fmt(borrowRaw, 6, 2)} USDC` : ''].filter(Boolean);
      await finish(hash, `You ${parts.join(' and ')}.`, borrowRaw > BigInt(0) ? 'Borrowed' : 'Collateral added');
    });

  const doRepay = () =>
    run('start', async () => {
      setDone(null);
      await wallet.ensureBase();
      // "All": the debt plus a hair for interest, but never more than the wallet holds (only the debt is taken).
      const allApproval = repayAllApproval(position.debtRaw);
      const approval = repayAll ? (allApproval < usdcBalance ? allApproval : usdcBalance) : repayRaw;
      if (usdcAllowance < approval) await approveSpoke(usdc.token, approval, 'USDC');
      setBusy('sign');
      const hash = await writeContractAsync({ ...spoke, functionName: 'repay', args: [BigInt(usdc.reserveId), repayAll ? MAX_UINT256 : repayRaw, address], dataSuffix: BUILDER_CODE_SUFFIX });
      setBusy('confirming');
      await waitOk(hash, 'The repay reverted onchain. Nothing changed.');
      await finish(hash, repayAll ? 'You repaid your whole USDC loan.' : `You repaid ${fmt(repayRaw, 6, 2)} USDC.`, 'Repaid');
    });

  const doWithdraw = () =>
    run('start', async () => {
      setDone(null);
      await wallet.ensureBase();
      const all = withdrawRaw === sel.supplied && !owes;
      setBusy('sign');
      const hash = await writeContractAsync({ ...spoke, functionName: 'withdraw', args: [BigInt(sel.s.reserveId), all ? MAX_UINT256 : withdrawRaw, address], dataSuffix: BUILDER_CODE_SUFFIX });
      setBusy('confirming');
      await waitOk(hash, 'The withdrawal reverted onchain (it would have put the loan over the limit). Nothing changed.');
      await finish(hash, `You withdrew ${fmt(withdrawRaw, sel.s.decimals)} ${sel.s.symbol}.`, 'Collateral withdrawn');
    });

  const busyLabel = busy?.startsWith('approve-')
    ? `Approve ${busy.slice(8)} in wallet…`
    : busy === 'sign'
      ? 'Confirm in wallet…'
      : busy === 'confirming'
        ? 'Confirming onchain…'
        : busy
          ? 'Preparing…'
          : null;

  const actionLabel =
    tab === 'borrow'
      ? addRaw > BigInt(0) && borrowRaw > BigInt(0)
        ? `Add ${sel.s.symbol} and borrow`
        : addRaw > BigInt(0)
          ? `Add ${sel.s.symbol} as collateral`
          : 'Borrow USDC'
      : tab === 'repay'
        ? repayAll
          ? 'Repay all'
          : 'Repay'
        : `Withdraw ${sel.s.symbol}`;
  const amountInput = (value: string, set: (v: string) => void, decimals: number, label: string) => (
    <input
      inputMode="decimal"
      aria-label={label}
      placeholder={label}
      className="basket-amount"
      value={value}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9.]/g, '');
        if (new RegExp(`^\\d*\\.?\\d{0,${decimals}}$`).test(v)) set(v);
      }}
      disabled={busy !== null}
    />
  );

  return (
    <div className="swap-panel">
      {/* The position as the chain sees it */}
      <div className="swap-review" style={{ marginTop: 0 }}>
        <dl>
          <dt>Collateral</dt>
          <dd>
            {held.length === 0
              ? 'none yet'
              : held.map((x) => `${fmt(x.supplied, x.s.decimals)} ${x.s.symbol} (${usd((Number(x.supplied) / 10 ** x.s.decimals) * x.priceUsd)})${x.enabled ? '' : ', not counted as collateral'}`).join(' · ')}
          </dd>
          <dt>You owe</dt>
          <dd>{owes ? `${fmt(position.debtRaw, 6, 2)} USDC` : 'nothing'} · borrow rate about {pct(borrowApr)} a year, variable</dd>
          <dt>Health</dt>
          <dd className={Number.isFinite(chainHf) && chainHf < 1.2 ? 'basis-neg' : undefined}>
            {hfText(chainHf)}
            {nowFall != null && ` · liquidated if your collateral falls ${pct(nowFall)} together`}
          </dd>
        </dl>
      </div>

      <div className="carry-direction-toggle swap-side-toggle" role="tablist" aria-label="Loan action">
        {(['borrow', 'repay', 'withdraw'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => setTab(t)}
            disabled={busy !== null || (t === 'repay' && !owes) || (t === 'withdraw' && held.length === 0)}
          >
            {t === 'borrow' ? 'Borrow' : t === 'repay' ? 'Repay' : 'Withdraw'}
          </button>
        ))}
      </div>

      {(tab === 'borrow' || tab === 'withdraw') && (
        <div className="action-field">
          <label htmlFor="aave-stock">Stock</label>
          <select id="aave-stock" value={sel.s.symbol} onChange={(e) => setSymbol(e.target.value)} disabled={busy !== null}>
            {choices.map((x) => (
              <option key={x.s.symbol} value={x.s.symbol}>
                {x.s.symbol} · {Math.round(x.s.collateralFactor * 100)}% limit
              </option>
            ))}
          </select>
        </div>
      )}

      {tab === 'borrow' && (
        <>
          <p className="geo-note">
            Add as collateral (optional) · wallet {fmt(sel.balance, sel.s.decimals)} {sel.s.symbol}, oracle {usd(sel.priceUsd)}
          </p>
          <div className="basket-row">
            {amountInput(addText, setAddText, sel.s.decimals, `${sel.s.symbol} to add`)}
            <button type="button" className="btn btn-secondary" onClick={() => setAddText(formatUnits(sel.balance, sel.s.decimals))} disabled={busy !== null || sel.balance === BigInt(0)}>
              Max
            </button>
          </div>
          <p className="geo-note">Borrow USDC · up to {fmt(borrowLimit, 6, 2)} with this collateral</p>
          <div className="basket-row">
            {amountInput(borrowText, setBorrowText, 6, 'USDC to borrow')}
            <button type="button" className="btn btn-secondary" onClick={() => setBorrowText(formatUnits(borrowLimit, 6))} disabled={busy !== null || borrowLimit === BigInt(0)}>
              Max
            </button>
          </div>
        </>
      )}

      {tab === 'repay' && (
        <>
          <p className="geo-note">Wallet {fmt(usdcBalance, 6, 2)} USDC · you owe {fmt(position.debtRaw, 6, 2)} USDC</p>
          <div className="basket-row">
            {amountInput(repayAll ? formatUnits(position.debtRaw, 6) : repayText, (v) => (setRepayAll(false), setRepayText(v)), 6, 'USDC to repay')}
            <button type="button" className="btn btn-secondary" onClick={() => setRepayAll(true)} disabled={busy !== null}>
              All
            </button>
          </div>
        </>
      )}

      {tab === 'withdraw' && (
        <>
          <p className="geo-note">
            Posted {fmt(sel.supplied, sel.s.decimals)} {sel.s.symbol} · up to {fmt(withdrawLimit, sel.s.decimals)} can come out now
          </p>
          <div className="basket-row">
            {amountInput(withdrawText, setWithdrawText, sel.s.decimals, `${sel.s.symbol} to withdraw`)}
            <button type="button" className="btn btn-secondary" onClick={() => setWithdrawText(formatUnits(withdrawLimit, sel.s.decimals))} disabled={busy !== null || withdrawLimit === BigInt(0)}>
              Max
            </button>
          </div>
        </>
      )}

      {problem && <p className="geo-note geo-note-blocked">{problem}</p>}
      {changed && !problem && (
        <p className={Number.isFinite(nextHf) && nextHf < 1.25 ? 'geo-note geo-note-blocked' : 'geo-note'}>
          After this: health {hfText(nextHf)}
          {nextFall != null ? `, liquidated if your collateral falls ${pct(nextFall)} together.` : '.'}
          {Number.isFinite(nextHf) && nextHf < 1.25 && ' That is close to the limit: a normal day’s move could liquidate part of it.'}
        </p>
      )}
      <div className="basket-row">
        <button
          type="button"
          className="btn"
          onClick={tab === 'borrow' ? doBorrow : tab === 'repay' ? doRepay : doWithdraw}
          disabled={busy !== null || !changed || !!problem}
        >
          {busyLabel ?? actionLabel}
        </button>
      </div>
      <p className="geo-note">
        {tab === 'borrow'
          ? 'Your wallet asks to approve exactly the stock you add (skipped if already approved), then one transaction that posts it and borrows. '
          : tab === 'repay'
            ? `Your wallet asks to approve the USDC${repayAll ? ' (what you owe plus 0.01% for interest until it is mined; only what is owed is taken)' : ''}, then the repay. `
            : 'One transaction; it reverts if it would put your loan over the limit. '}
        Aave&apos;s stock prices can stop updating while the stock market is closed, and interest keeps running all weekend. You need a
        little ETH on Base for network fees.
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
