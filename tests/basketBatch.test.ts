import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { basketBatchCalls, basketSellBatchCalls, canBatchAtomically, isBasketBatchCall } from '../lib/swap/basketBatch';
import { KYBER_ROUTER, type SwapTx } from '../lib/swap/swap';
import { BUILDER_CODE_SUFFIX } from '../lib/wallet/builderCode';
import { dryRunVerdict } from '../lib/swap/dryRun';
import { USDC } from '../lib/stocks/tokens';

const routerAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
]);
const EXEC = '0x2222222222222222222222222222222222222222' as const;
const ME = '0x1111111111111111111111111111111111111111' as const;
const swapData = (src: string, dst: string, amount: bigint, extra: { feeReceivers?: `0x${string}`[]; feeAmounts?: bigint[]; minReturnAmount?: bigint; permit?: Hex; srcAmounts?: bigint[] } = {}) =>
  encodeFn({
    abi: routerAbi,
    functionName: 'swap',
    args: [{ callTarget: EXEC, approveTarget: EXEC, targetData: '0x', clientData: '0x', desc: { srcToken: addr(src), dstToken: addr(dst), srcReceivers: [EXEC], srcAmounts: [amount], feeReceivers: [], feeAmounts: [], dstReceiver: ME, amount, minReturnAmount: BigInt(1), flags: BigInt(0), permit: '0x', ...extra } }],
  });
const leg = (symbol: string, amountIn: bigint, data: Hex = swapData(USDC.address, getStock(symbol)!.tokenAddress, amountIn)): SwapTx => ({
  quote: { symbol, side: 'buy', amountIn: amountIn.toString(), amountOut: '1', amountInUsd: Number(amountIn) / 1e6, amountOutUsd: 0, gasUsd: 0, feeBps: 0, venues: [] },
  to: KYBER_ROUTER,
  data,
  minAmountOut: '1',
  spender: KYBER_ROUTER,
  tokenIn: USDC.address as `0x${string}`,
});
const legs = [leg('NVDAc', BigInt(40_000_000)), leg('AAPLc', BigInt(60_000_000))];
const suffix = BUILDER_CODE_SUFFIX.slice(2).toLowerCase();

describe('basketBatchCalls', () => {
  it('approves exactly the total for the router, then one swap per stock, every call with the Builder Code', () => {
    const calls = basketBatchCalls(legs, true);
    expect(calls.map((c) => c.to)).toEqual([USDC.address, KYBER_ROUTER, KYBER_ROUTER]);
    for (const c of calls) {
      expect(c.data.toLowerCase().endsWith(suffix)).toBe(true);
      expect(c.value).toBe(BigInt(0));
      expect(isBasketBatchCall(c)).toBe(true);
    }
    const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(approve.functionName).toBe('approve');
    expect(approve.args).toEqual([KYBER_ROUTER, BigInt(100_000_000)]);
    expect(calls[1].data.toLowerCase()).toBe((legs[0].data + suffix).toLowerCase());
  });
  it('leaves the approval out when the router can already spend the total', () => {
    expect(basketBatchCalls(legs, false).map((c) => c.to)).toEqual([KYBER_ROUTER, KYBER_ROUTER]);
  });
  it('refuses a swap that is not a USDC buy through the router', () => {
    expect(() => basketBatchCalls([{ ...legs[0], to: '0x0000000000000000000000000000000000000001' as never }], true)).toThrow(/unexpected contract/);
    expect(() => basketBatchCalls([{ ...legs[0], spender: '0x0000000000000000000000000000000000000001' as never }], true)).toThrow(/unexpected contract/);
    expect(() => basketBatchCalls([{ ...legs[0], quote: { ...legs[0].quote, side: 'sell' } }], true)).toThrow(/USDC/);
    expect(() => basketBatchCalls([{ ...legs[0], tokenIn: '0x0000000000000000000000000000000000000002' }], true)).toThrow(/USDC/);
    expect(() => basketBatchCalls([], true)).toThrow(/nothing/);
  });
  it('refuses calldata that is not the trade shown: another minimum, another amount, oversized splits, or none that decodes', () => {
    const nvda = getStock('NVDAc')!.tokenAddress;
    const amt = BigInt(40_000_000);
    expect(() => basketBatchCalls([{ ...legs[0], minAmountOut: '2' }], true)).toThrow(/minimum is not the one shown/);
    expect(() => basketBatchCalls([leg('NVDAc', amt, swapData(USDC.address, nvda, amt - BigInt(1)))], true)).toThrow(/different amount/);
    expect(() => basketBatchCalls([leg('NVDAc', amt, swapData(USDC.address, nvda, amt, { srcAmounts: [amt, BigInt(1)] }))], true)).toThrow(/split amounts/);
    expect(() => basketBatchCalls([leg('NVDAc', amt, '0xe21fd0e9aa')], true)).toThrow(/does not decode/);
    expect(() => basketSellBatchCalls([{ ...sells[0], minAmountOut: '2' }], [true])).toThrow(/minimum is not the one shown/);
  });
});

describe('isBasketBatchCall', () => {
  it('refuses an approval for anyone but the router, any other token or contract, and any value', () => {
    const other = '0x0000000000000000000000000000000000000003';
    const approveOther = basketBatchCalls(legs, true)[0];
    const data = approveOther.data.replace(KYBER_ROUTER.slice(2).toLowerCase(), other.slice(2)) as Hex;
    expect(isBasketBatchCall({ ...approveOther, data })).toBe(false);
    expect(isBasketBatchCall({ ...approveOther, to: other })).toBe(false);
    expect(isBasketBatchCall({ to: KYBER_ROUTER, data: '0x', value: BigInt(1) })).toBe(false);
    expect(isBasketBatchCall({ to: USDC.address as `0x${string}`, data: '0xa9059cbb', value: BigInt(0) })).toBe(false);
  });
});

describe('canBatchAtomically', () => {
  it('only when the wallet says atomic batches are supported on Base now', () => {
    expect(canBatchAtomically({ atomic: { status: 'supported' } })).toBe(true);
    expect(canBatchAtomically({ atomic: { status: 'ready' } })).toBe(false);
    expect(canBatchAtomically({ atomic: { status: 'unsupported' } })).toBe(false);
    expect(canBatchAtomically({})).toBe(false);
    expect(canBatchAtomically(undefined)).toBe(false);
  });
});

// Sells (2026-11-19) and the whole-batch check sendBatch runs before the wallet sees anything.
import { encodeFunctionData as encodeFn, getAddress as addr, parseAbi } from 'viem';
import { basketBatchProblem } from '../lib/swap/basketBatch';
import { getStock } from '../lib/stocks/tokens';

const sellLeg = (symbol: string, amount: bigint): SwapTx => {
  const s = getStock(symbol)!;
  return {
    quote: { symbol, side: 'sell', amountIn: amount.toString(), amountOut: '1', amountInUsd: 3, amountOutUsd: 3, gasUsd: 0, feeBps: 0, venues: [] },
    to: KYBER_ROUTER,
    data: swapData(s.tokenAddress, USDC.address, amount),
    minAmountOut: '1',
    spender: KYBER_ROUTER,
    tokenIn: s.tokenAddress,
  };
};
const sells = [sellLeg('AMZNc', BigInt(1010145)), sellLeg('NVDAc', BigInt(1791649))];

describe('basketSellBatchCalls', () => {
  it("approves each stock exactly its leg's amount for the router, then its swap, every call with the Builder Code", () => {
    const calls = basketSellBatchCalls(sells, [true, true]);
    expect(calls.map((c) => c.to)).toEqual([addr(getStock('AMZNc')!.tokenAddress), KYBER_ROUTER, addr(getStock('NVDAc')!.tokenAddress), KYBER_ROUTER]);
    for (const c of calls) {
      expect(c.data.toLowerCase().endsWith(suffix)).toBe(true);
      expect(c.value).toBe(BigInt(0));
    }
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0].data }).args).toEqual([KYBER_ROUTER, BigInt(1010145)]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[2].data }).args).toEqual([KYBER_ROUTER, BigInt(1791649)]);
    expect(basketBatchProblem(calls, ME)).toBeNull();
  });
  it('leaves out an approval the router already has', () => {
    expect(basketSellBatchCalls(sells, [false, true]).map((c) => c.to)).toEqual([KYBER_ROUTER, addr(getStock('NVDAc')!.tokenAddress), KYBER_ROUTER]);
  });
  it('refuses a buy, a token that is not the stock, an untracked stock, a stock twice, a wrong router, or mismatched approvals', () => {
    expect(() => basketSellBatchCalls([{ ...sells[0], quote: { ...sells[0].quote, side: 'buy' } }], [true])).toThrow(/own stocks/);
    expect(() => basketSellBatchCalls([{ ...sells[0], tokenIn: USDC.address as `0x${string}` }], [true])).toThrow(/own stocks/);
    expect(() => basketSellBatchCalls([{ ...sells[0], quote: { ...sells[0].quote, symbol: 'NOPEc' } }], [true])).toThrow(/own stocks/);
    expect(() => basketSellBatchCalls([sells[0], sells[0]], [true, true])).toThrow(/twice/);
    expect(() => basketSellBatchCalls([{ ...sells[0], to: '0x0000000000000000000000000000000000000001' as never }], [true])).toThrow(/unexpected contract/);
    expect(() => basketSellBatchCalls(sells, [true])).toThrow(/one approval decision/);
    expect(() => basketSellBatchCalls([], [])).toThrow(/nothing/);
  });
});

describe('basketBatchProblem', () => {
  const buy = (symbol: string, amount: bigint) => swapData(USDC.address, getStock(symbol)!.tokenAddress, amount);
  const approveOf = (token: string, amount: bigint) => ({ to: addr(token), data: encodeFn({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, amount] }) as Hex, value: BigInt(0) });
  const swapCall = (data: Hex) => ({ to: KYBER_ROUTER, data, value: BigInt(0) });
  it('accepts a buy whose one approval is exactly what its swaps spend', () => {
    expect(basketBatchProblem([approveOf(USDC.address, BigInt(100)), swapCall(buy('NVDAc', BigInt(40))), swapCall(buy('AAPLc', BigInt(60)))], ME)).toBeNull();
    expect(basketBatchProblem([swapCall(buy('NVDAc', BigInt(40)))], ME)).toBeNull();
  });
  it('refuses an approval above, below or without the swaps, an unlimited one, two of one token, a swap that does not decode, and an empty batch', () => {
    const max = BigInt(2) ** BigInt(256) - BigInt(1);
    expect(basketBatchProblem([approveOf(USDC.address, BigInt(101)), swapCall(buy('NVDAc', BigInt(100)))], ME)).toMatch(/not exactly/);
    expect(basketBatchProblem([approveOf(USDC.address, BigInt(99)), swapCall(buy('NVDAc', BigInt(100)))], ME)).toMatch(/not exactly/);
    expect(basketBatchProblem([approveOf(USDC.address, max), swapCall(buy('NVDAc', BigInt(100)))], ME)).toMatch(/not exactly/);
    expect(basketBatchProblem([approveOf(getStock('NVDAc')!.tokenAddress, BigInt(5)), swapCall(buy('NVDAc', BigInt(100)))], ME)).toMatch(/not exactly/);
    expect(basketBatchProblem([approveOf(USDC.address, BigInt(50)), approveOf(USDC.address, BigInt(50)), swapCall(buy('NVDAc', BigInt(100)))], ME)).toMatch(/two approvals/);
    expect(basketBatchProblem([swapCall('0xe21fd0e9aa')], ME)).toMatch(/does not decode/);
    expect(basketBatchProblem([{ to: '0x0000000000000000000000000000000000000009', data: '0x', value: BigInt(0) }], ME)).toMatch(/unexpected contract/);
    expect(basketBatchProblem([], ME)).toMatch(/nothing/);
    expect(basketBatchProblem([swapCall(buy('NVDAc', BigInt(40)))], '0x3333333333333333333333333333333333333333')).toMatch(/pays someone else/);
  });
  it('refuses a fee receiver, a permit, a zero minimum, and any pair that is not USDC against a tracked stock', () => {
    const nvda = getStock('NVDAc')!.tokenAddress;
    const aapl = getStock('AAPLc')!.tokenAddress;
    const fee = swapData(USDC.address, nvda, BigInt(40), { feeReceivers: ['0x4444444444444444444444444444444444444444'], feeAmounts: [BigInt(10)] });
    expect(basketBatchProblem([swapCall(fee)], ME)).toMatch(/fee/);
    expect(basketBatchProblem([swapCall(swapData(USDC.address, nvda, BigInt(40), { feeAmounts: [BigInt(10)] }))], ME)).toMatch(/fee/);
    expect(basketBatchProblem([swapCall(swapData(USDC.address, nvda, BigInt(40), { srcAmounts: [BigInt(40), BigInt(1)] }))], ME)).toMatch(/split amounts/);
    expect(basketBatchProblem([swapCall(swapData('0x5555555555555555555555555555555555555555', USDC.address, BigInt(40)))], ME)).toMatch(/not USDC against a tracked stock/);
    expect(basketBatchProblem([swapCall(swapData(USDC.address, nvda, BigInt(40), { permit: '0x1234' }))], ME)).toMatch(/permit/);
    expect(basketBatchProblem([swapCall(swapData(USDC.address, nvda, BigInt(40), { minReturnAmount: BigInt(0) }))], ME)).toMatch(/no minimum/);
    expect(basketBatchProblem([swapCall(swapData(nvda, aapl, BigInt(40)))], ME)).toMatch(/not USDC against a tracked stock/);
    expect(basketBatchProblem([swapCall(swapData(USDC.address, USDC.address, BigInt(40)))], ME)).toMatch(/not USDC against a tracked stock/);
    expect(basketBatchProblem([swapCall(swapData(USDC.address, '0x5555555555555555555555555555555555555555', BigInt(40)))], ME)).toMatch(/not USDC against a tracked stock/);
    expect(basketBatchProblem([swapCall(swapData(nvda, USDC.address, BigInt(40)))], ME)).toBeNull();
  });
});

// A single stock swap from Base Account (2026-11-24): the same batch with one leg, its exact approval and its swap.
describe('one-signature single swaps', () => {
  it('a buy: approve exactly its amount, then the swap; passes the batch check; a sell likewise', () => {
    const buy = basketBatchCalls([legs[0]], true);
    expect(buy.map((c) => c.to)).toEqual([addr(USDC.address), KYBER_ROUTER]);
    expect(decodeFunctionData({ abi: erc20Abi, data: buy[0].data }).args).toEqual([KYBER_ROUTER, BigInt(40_000_000)]);
    expect(basketBatchProblem(buy, ME)).toBeNull();
    const sell = basketSellBatchCalls([sells[1]], [true]);
    expect(sell.map((c) => c.to)).toEqual([addr(getStock('NVDAc')!.tokenAddress), KYBER_ROUTER]);
    expect(basketBatchProblem(sell, ME)).toBeNull();
    for (const c of [...buy, ...sell]) expect(c.data.toLowerCase().endsWith(suffix)).toBe(true);
  });
});

describe('dry run verdict', () => {
  it('blocks only a dry run that ran and failed; a node that can’t simulate never blocks', () => {
    expect(dryRunVerdict({ results: [{ status: 'success' }, { status: 'success' }] })).toBe('ok');
    expect(dryRunVerdict({ results: [{ status: 'success' }, { status: 'failure' }] })).toBe('reverts');
    expect(dryRunVerdict({ results: [] })).toBe('unknown');
    expect(dryRunVerdict({ error: { shortMessage: 'Execution reverted with reason: Call failed.' } })).toBe('reverts');
    expect(dryRunVerdict({ error: { shortMessage: 'HTTP request failed.', details: 'method eth_simulateV1 not found' } })).toBe('unknown');
    expect(dryRunVerdict({ error: null })).toBe('unknown');
  });
});
