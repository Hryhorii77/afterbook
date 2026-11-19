// The browser's own floor under every swap (lib/swap/swapFloor.ts).
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { MAX_POOL_GAP_BPS, poolPriceProblem, poolUsdPerToken, signedFloorProblem } from '../lib/swap/swapFloor';
import { KYBER_ROUTER, type SwapTx } from '../lib/swap/swap';
import { getStock, USDC } from '../lib/stocks/tokens';

const routerAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
]);
const EXEC = '0x2222222222222222222222222222222222222222' as const;
const ME = '0x1111111111111111111111111111111111111111' as const;
const NVDA = getStock('NVDAc')!;
type Extra = { src?: `0x${string}`; dst?: `0x${string}`; feeReceivers?: `0x${string}`[]; feeAmounts?: bigint[]; permit?: Hex; srcAmounts?: bigint[] };
const data = (amount: bigint, min: bigint, to: `0x${string}` = ME, x: Extra = {}) =>
  encodeFunctionData({
    abi: routerAbi,
    functionName: 'swap',
    args: [{ callTarget: EXEC, approveTarget: EXEC, targetData: '0x', clientData: '0x', desc: { srcToken: x.src ?? getAddress(USDC.address), dstToken: x.dst ?? NVDA.tokenAddress, srcReceivers: [EXEC], srcAmounts: x.srcAmounts ?? [amount], feeReceivers: x.feeReceivers ?? [], feeAmounts: x.feeAmounts ?? [], dstReceiver: to, amount, minReturnAmount: min, flags: BigInt(0), permit: x.permit ?? '0x' } }],
  }) as Hex;
// $100 of NVDAc at $200 a token: 0.5 token out.
const outRaw = BigInt(5) * BigInt(10) ** BigInt(NVDA.decimals - 1);
const minAt = (bps: number) => (outRaw * BigInt(10000 - bps)) / BigInt(10000);
const tx = (min: bigint, over: Partial<SwapTx> = {}, amount = BigInt(100_000_000)): SwapTx => ({
  quote: { symbol: 'NVDAc', side: 'buy', amountIn: amount.toString(), amountOut: outRaw.toString(), amountInUsd: 100, amountOutUsd: 100, gasUsd: 0, feeBps: 0, venues: [] },
  to: KYBER_ROUTER,
  data: data(amount, min),
  minAmountOut: min.toString(),
  spender: KYBER_ROUTER,
  tokenIn: USDC.address as `0x${string}`,
  ...over,
});
const asked = { amountIn: '100000000', account: ME, slippageBps: 50, tokenIn: USDC.address as `0x${string}`, tokenOut: NVDA.tokenAddress };

describe('signedFloorProblem', () => {
  it('accepts a minimum at the slippage limit', () => {
    expect(signedFloorProblem(tx(minAt(50)), asked)).toBeNull();
    expect(signedFloorProblem(tx(minAt(10)), asked)).toBeNull();
  });
  it('refuses a minimum below the slippage setting, even when the card shows the same number', () => {
    expect(signedFloorProblem(tx(minAt(60)), asked)).toMatch(/below your slippage/);
    expect(signedFloorProblem(tx(BigInt(1)), asked)).toMatch(/below your slippage/);
  });
  it('refuses a signed minimum other than the one shown, another amount or recipient, or no minimum', () => {
    expect(signedFloorProblem({ ...tx(minAt(50)), minAmountOut: minAt(40).toString() }, asked)).toMatch(/not the one shown/);
    expect(signedFloorProblem(tx(minAt(50), {}, BigInt(99_000_000)), asked)).toMatch(/different amount/);
    expect(signedFloorProblem({ ...tx(minAt(50)), data: data(BigInt(100_000_000), minAt(50), '0x3333333333333333333333333333333333333333') }, asked)).toMatch(/someone else/);
    expect(signedFloorProblem(tx(BigInt(0)), asked)).toMatch(/no minimum/);
    expect(signedFloorProblem({ ...tx(minAt(50)), data: '0xe21fd0e9aa' }, asked)).toMatch(/does not decode/);
  });
  it('refuses calldata that trades other tokens than asked, takes a fee, carries a permit or over-splits', () => {
    const amt = BigInt(100_000_000);
    const with_ = (x: Extra) => ({ ...tx(minAt(50)), data: data(amt, minAt(50), ME, x) });
    expect(signedFloorProblem(with_({ dst: getStock('AAPLc')!.tokenAddress }), asked)).toMatch(/buys a different token/);
    expect(signedFloorProblem(with_({ dst: '0x5555555555555555555555555555555555555555' }), asked)).toMatch(/buys a different token/);
    expect(signedFloorProblem(with_({ src: NVDA.tokenAddress }), asked)).toMatch(/pays with a different token/);
    expect(signedFloorProblem({ ...tx(minAt(50)), tokenIn: NVDA.tokenAddress }, asked)).toMatch(/pays with a different token/);
    expect(signedFloorProblem(with_({ feeReceivers: ['0x4444444444444444444444444444444444444444'], feeAmounts: [BigInt(10)] }), asked)).toMatch(/fee/);
    expect(signedFloorProblem(with_({ feeAmounts: [BigInt(10)] }), asked)).toMatch(/fee/);
    expect(signedFloorProblem(with_({ permit: '0x1234' }), asked)).toMatch(/permit/);
    expect(signedFloorProblem(with_({ srcAmounts: [amt, BigInt(1)] }), asked)).toMatch(/split amounts/);
  });
});

describe('poolPriceProblem', () => {
  // sqrtPriceX96 for $200 a NVDAc token with USDC as token0: stock raw per USDC raw = 10^(dec-6) / 200.
  const sqrtFor = (usd: number) => BigInt(Math.round(Math.sqrt(10 ** (NVDA.decimals - USDC.decimals) / usd) * 2 ** 96));
  it('reads the pool price, whichever token the pool lists first', () => {
    expect(poolUsdPerToken(sqrtFor(200), NVDA)).toBeCloseTo(200, 6);
    // A pool sorted the other way: token1 is USDC, so sqrtP² is USDC raw per stock raw.
    const flipped = { ...NVDA, pool: { ...NVDA.pool, token0: 'stock' as const } };
    const sqrtStockFirst = BigInt(Math.round(Math.sqrt((200 * 10 ** USDC.decimals) / 10 ** NVDA.decimals) * 2 ** 96));
    expect(poolUsdPerToken(sqrtStockFirst, flipped)).toBeCloseTo(200, 6);
  });
  it('accepts a quote near the pool price and refuses one far worse than it, for buys and sells', () => {
    // A buy of $100 for 0.5 token is worth $85 at a pool price of $170: over 5% worse.
    expect(poolPriceProblem(tx(minAt(50)), NVDA, sqrtFor(200))).toBeNull();
    expect(poolPriceProblem(tx(minAt(50)), NVDA, sqrtFor(200 * (1 - (MAX_POOL_GAP_BPS - 50) / 10000)))).toBeNull();
    expect(poolPriceProblem(tx(minAt(50)), NVDA, sqrtFor(170))).toMatch(/worse than NVDAc's pool price/);
    const sell = (usdcOut: number): SwapTx => ({ ...tx(BigInt(1)), quote: { ...tx(BigInt(1)).quote, side: 'sell', amountIn: outRaw.toString(), amountOut: String(usdcOut * 1e6) } });
    expect(poolPriceProblem(sell(99), NVDA, sqrtFor(200))).toBeNull();
    expect(poolPriceProblem(sell(1), NVDA, sqrtFor(200))).toMatch(/worse/);
  });
});
