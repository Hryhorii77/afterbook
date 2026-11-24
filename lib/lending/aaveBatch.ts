// One signature for the in-app Aave panels with a wallet that runs batches atomically on Base (Base Account;
// 2026-11-24, owner: the second wallet window, after an approval, was blocked by the browser on every borrow
// and repay). The exact approval of what the spoke pulls (only when the allowance is short) and the spoke call
// go as one atomic batch. Pure, so the panels and the tests build and check exactly the same calls; every rule
// of the two-step flow still holds: approvals are exact and name only the spoke, every spoke call is on behalf
// of the signer, and every call carries Afterbook's Builder Code.
import { concat, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from '../wallet/builderCode';
import { AAVE_MAG7_SPOKE, MAX_UINT256, SPOKE_ABI } from './aaveBorrow';
import type { BatchCall } from '../swap/basketBatch';

const SPOKE = getAddress(AAVE_MAG7_SPOKE);

/** approve(spoke, amount) of `token`, with the Builder Code. */
export function spokeApprovalCall(token: `0x${string}`, amount: bigint): BatchCall {
  return { to: getAddress(token), data: concat([encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SPOKE, amount] }), BUILDER_CODE_SUFFIX]), value: BigInt(0) };
}

/** A spoke call (already encoded), with the Builder Code. */
export function spokeCall(data: Hex): BatchCall {
  return { to: SPOKE, data: concat([data, BUILDER_CODE_SUFFIX]), value: BigInt(0) };
}

/** [approve when `approve`] + the spoke call. */
export function aaveBatchCalls(spokeData: Hex, approval?: { token: `0x${string}`; amount: bigint } | null): BatchCall[] {
  return [...(approval ? [spokeApprovalCall(approval.token, approval.amount)] : []), spokeCall(spokeData)];
}

const SPOKE_FNS = new Set(['supply', 'withdraw', 'borrow', 'repay', 'setUsingAsCollateral']);

/**
 * The batch, just before the wallet sees it: only approvals (of a reserve's own token, naming the spoke, never
 * unlimited, one per token) and spoke calls (supply, withdraw, borrow, repay, setUsingAsCollateral, or a
 * multicall of them), every one on behalf of `account`; and each approval exactly what the batch's spoke calls
 * pull of that token (a supply's or a repay's amount; a full repay, `MAX_UINT256`, at most `repayAllCap`).
 * Returns a reason to refuse, or null.
 */
export function aaveBatchProblem(calls: BatchCall[], account: `0x${string}`, reserves: { reserveId: number; token: `0x${string}` }[], repayAllCap?: bigint): string | null {
  if (calls.length === 0) return 'nothing to send';
  const me = getAddress(account);
  const tokenOf = new Map(reserves.map((r) => [r.reserveId, getAddress(r.token)]));
  const tokens = new Set(tokenOf.values());
  const approvals = new Map<string, bigint>();
  const pulls = new Map<string, { amount: bigint; all: boolean }>();
  const pull = (token: string, amount: bigint, all = false) => {
    const prev = pulls.get(token);
    pulls.set(token, { amount: (prev?.amount ?? BigInt(0)) + (all ? BigInt(0) : amount), all: (prev?.all ?? false) || all });
  };
  const checkSpoke = (data: Hex, nested: boolean): string | null => {
    let d;
    try {
      d = decodeFunctionData({ abi: SPOKE_ABI, data });
    } catch {
      return 'a spoke call that does not decode';
    }
    if (d.functionName === 'multicall') {
      if (nested) return 'a nested multicall';
      for (const inner of d.args[0] as readonly Hex[]) {
        const p = checkSpoke(inner, true);
        if (p) return p;
      }
      return null;
    }
    if (!SPOKE_FNS.has(d.functionName)) return `an unexpected spoke call (${d.functionName})`;
    const args = d.args as readonly unknown[];
    const reserveId = Number(args[0] as bigint);
    if (!tokenOf.has(reserveId)) return 'an unknown reserve';
    if (getAddress(args[2] as string) !== me) return 'a call on behalf of someone else';
    const token = tokenOf.get(reserveId)!;
    if (d.functionName === 'supply') pull(token, args[1] as bigint);
    if (d.functionName === 'repay') {
      const amount = args[1] as bigint;
      if (amount === MAX_UINT256) pull(token, BigInt(0), true);
      else pull(token, amount);
    }
    return null;
  };
  for (const c of calls) {
    if (c.value !== BigInt(0)) return 'a call that sends ETH';
    const to = getAddress(c.to);
    if (to === SPOKE) {
      const p = checkSpoke(c.data, false);
      if (p) return p;
      continue;
    }
    if (!tokens.has(to)) return 'unexpected contract';
    let d;
    try {
      d = decodeFunctionData({ abi: erc20Abi, data: c.data });
    } catch {
      return 'a token call that does not decode';
    }
    if (d.functionName !== 'approve') return 'a token call that is not an approval';
    if (getAddress(d.args[0] as string) !== SPOKE) return 'an approval for anyone but the spoke';
    if (approvals.has(to)) return 'two approvals of one token';
    const amount = d.args[1] as bigint;
    if (amount === BigInt(0) || amount > MAX_UINT256 / BigInt(2)) return 'an approval that is zero or unlimited';
    approvals.set(to, amount);
  }
  for (const [token, amount] of approvals) {
    const p = pulls.get(token);
    if (!p) return 'an approval nothing in the batch uses';
    if (p.all) {
      // A full repay pulls what is owed at mining: the approval is the panel's capped buffer, never more.
      if (repayAllCap == null || amount > repayAllCap || p.amount !== BigInt(0)) return 'a full repay approval above its cap';
    } else if (amount !== p.amount) return 'an approval that is not exactly what the calls pull';
  }
  return null;
}
