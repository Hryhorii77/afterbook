import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, type Hex } from 'viem';
import { aaveBatchCalls, aaveBatchProblem, spokeApprovalCall, spokeCall } from '../lib/lending/aaveBatch';
import { AAVE_MAG7_SPOKE, MAX_UINT256, SPOKE_ABI, borrowCalls, type AaveReserve } from '../lib/lending/aaveBorrow';
import { BUILDER_CODE_SUFFIX } from '../lib/wallet/builderCode';

// One signature for the Aave panels with Base Account (2026-11-24): the exact approval and the spoke call as one
// atomic batch, checked before the wallet sees it.
const NVDA: AaveReserve = { reserveId: 3, symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', decimals: 8, collateralFactor: 0.7 };
const USDC: AaveReserve = { reserveId: 0, symbol: 'USDC', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, collateralFactor: 0 };
const ME = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const reserves = [NVDA, USDC];
const suffix = BUILDER_CODE_SUFFIX.slice(2).toLowerCase();
const spokeData = (fn: 'supply' | 'withdraw' | 'borrow' | 'repay', reserve: AaveReserve, amount: bigint, who: `0x${string}` = ME) =>
  encodeFunctionData({ abi: SPOKE_ABI, functionName: fn, args: [BigInt(reserve.reserveId), amount, who] }) as Hex;
const multicall = (calls: Hex[]) => encodeFunctionData({ abi: SPOKE_ABI, functionName: 'multicall', args: [calls] }) as Hex;

describe('aaveBatchCalls', () => {
  it('approve exactly for the spoke, then the spoke call, both with the Builder Code', () => {
    const add = BigInt(7_831_068);
    const calls = aaveBatchCalls(multicall(borrowCalls(ME, { stock: NVDA, addRaw: add, enableCollateral: true, usdc: USDC, borrowRaw: BigInt(5_000_000) })), { token: NVDA.token, amount: add });
    expect(calls.map((c) => c.to.toLowerCase())).toEqual([NVDA.token.toLowerCase(), AAVE_MAG7_SPOKE.toLowerCase()]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([expect.stringMatching(/^0x/i), add]);
    for (const c of calls) {
      expect(c.data.toLowerCase().endsWith(suffix)).toBe(true);
      expect(c.value).toBe(BigInt(0));
    }
    expect(aaveBatchProblem(calls, ME, reserves)).toBeNull();
    // Without an approval: just the spoke call.
    expect(aaveBatchCalls(spokeData('withdraw', NVDA, add), null)).toHaveLength(1);
  });
});

describe('aaveBatchProblem', () => {
  it('accepts a repay with its exact approval, and a full repay up to its cap', () => {
    expect(aaveBatchProblem(aaveBatchCalls(spokeData('repay', USDC, BigInt(500_000)), { token: USDC.token, amount: BigInt(500_000) }), ME, reserves)).toBeNull();
    const all = aaveBatchCalls(spokeData('repay', USDC, MAX_UINT256), { token: USDC.token, amount: BigInt(5_000_502) });
    expect(aaveBatchProblem(all, ME, reserves, BigInt(5_000_502))).toBeNull();
    expect(aaveBatchProblem(all, ME, reserves, BigInt(5_000_000))).toMatch(/cap/);
    expect(aaveBatchProblem(all, ME, reserves)).toMatch(/cap/);
  });
  it('refuses an approval that isn’t exactly what is pulled, unlimited, for anyone else, unused, or twice', () => {
    const repay = spokeData('repay', USDC, BigInt(500_000));
    expect(aaveBatchProblem(aaveBatchCalls(repay, { token: USDC.token, amount: BigInt(500_001) }), ME, reserves)).toMatch(/exactly/);
    expect(aaveBatchProblem(aaveBatchCalls(repay, { token: USDC.token, amount: MAX_UINT256 }), ME, reserves)).toMatch(/unlimited/);
    const toOther = { to: USDC.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OTHER, BigInt(500_000)] }) as Hex, value: BigInt(0) };
    expect(aaveBatchProblem([toOther, spokeCall(repay)], ME, reserves)).toMatch(/spoke/);
    expect(aaveBatchProblem(aaveBatchCalls(spokeData('withdraw', NVDA, BigInt(1)), { token: NVDA.token, amount: BigInt(1) }), ME, reserves)).toMatch(/nothing in the batch uses/);
    expect(aaveBatchProblem([spokeApprovalCall(USDC.token, BigInt(500_000)), spokeApprovalCall(USDC.token, BigInt(500_000)), spokeCall(repay)], ME, reserves)).toMatch(/two approvals/);
  });
  it('refuses a call for someone else, another contract, a transfer, ETH, an unknown reserve or a nested multicall', () => {
    expect(aaveBatchProblem([spokeCall(spokeData('borrow', USDC, BigInt(1), OTHER))], ME, reserves)).toMatch(/someone else/);
    expect(aaveBatchProblem([spokeCall(multicall([spokeData('borrow', USDC, BigInt(1), OTHER)]))], ME, reserves)).toMatch(/someone else/);
    expect(aaveBatchProblem([{ to: OTHER, data: '0x', value: BigInt(0) }], ME, reserves)).toMatch(/unexpected contract/);
    const transfer = { to: USDC.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [OTHER, BigInt(1)] }) as Hex, value: BigInt(0) };
    expect(aaveBatchProblem([transfer], ME, reserves)).toMatch(/not an approval/);
    expect(aaveBatchProblem([{ ...spokeCall(spokeData('withdraw', NVDA, BigInt(1))), value: BigInt(1) }], ME, reserves)).toMatch(/ETH/);
    expect(aaveBatchProblem([spokeCall(spokeData('withdraw', { ...NVDA, reserveId: 99 }, BigInt(1)))], ME, reserves)).toMatch(/unknown reserve/);
    expect(aaveBatchProblem([spokeCall(multicall([multicall([spokeData('withdraw', NVDA, BigInt(1))])]))], ME, reserves)).toMatch(/nested/);
    expect(aaveBatchProblem([], ME, reserves)).toMatch(/nothing/);
  });
});
