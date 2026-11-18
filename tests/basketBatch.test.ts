import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, type Hex } from 'viem';
import { basketBatchCalls, canBatchAtomically, isBasketBatchCall } from '../lib/swap/basketBatch';
import { KYBER_ROUTER, type SwapTx } from '../lib/swap/swap';
import { BUILDER_CODE_SUFFIX } from '../lib/wallet/builderCode';
import { USDC } from '../lib/stocks/tokens';

const leg = (symbol: string, amountIn: bigint, data: Hex): SwapTx => ({
  quote: { symbol, side: 'buy', amountIn: amountIn.toString(), amountOut: '1', amountInUsd: Number(amountIn) / 1e6, amountOutUsd: 0, gasUsd: 0, feeBps: 0, venues: [] },
  to: KYBER_ROUTER,
  data,
  minAmountOut: '1',
  spender: KYBER_ROUTER,
  tokenIn: USDC.address as `0x${string}`,
});
const legs = [leg('NVDAc', BigInt(40_000_000), '0xe21fd0e9aa'), leg('AAPLc', BigInt(60_000_000), '0xe21fd0e9bb')];
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
    expect(calls[1].data.toLowerCase()).toBe(('0xe21fd0e9aa' + suffix).toLowerCase());
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
