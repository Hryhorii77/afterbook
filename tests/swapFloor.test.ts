// The browser's own floor under every swap (lib/swap/swapFloor.ts).
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { MAX_FILL_GAP_BPS, poolFillProblem, signedFloorProblem } from '../lib/swap/swapFloor';
import { simulateBuy, simulateSell } from '../lib/market/swapSim';
import type { PoolState } from '../lib/market/quote';
import type { LiquidityDistribution } from '../lib/market/depth';
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

describe('poolFillProblem', () => {
  // A synthetic NVDAc pool at $200 a token (USDC is token0), with one range of liquidity around the price.
  const sqrtP = Math.sqrt(10 ** (NVDA.decimals - USDC.decimals) / 200);
  const tick = Math.floor(Math.log(sqrtP * sqrtP) / Math.log(1.0001));
  const pool = (liquidity: bigint) => {
    const state = { sqrtPriceX96: BigInt(Math.round(sqrtP * 2 ** 96)), tick, liquidity, multiplier: BigInt(10) ** BigInt(18), usdcReserveRaw: BigInt(0), stockReserveRaw: BigInt(0), feeGrowthGlobal0X128: BigInt(0), feeGrowthGlobal1X128: BigInt(0), feePpm: 500 } as PoolState;
    const dist = { currentTick: tick, currentPriceUsd: 200, buckets: [{ tickLower: tick - 2000, tickUpper: tick + 2000, priceLowerUsd: 0, priceUpperUsd: 0, liquidity: liquidity.toString() }] } as LiquidityDistribution;
    return { state, dist };
  };
  const deep = pool(BigInt(10) ** BigInt(16));
  const withOut = (side: 'buy' | 'sell', amountIn: bigint, amountOut: number): SwapTx => ({ ...tx(BigInt(1)), quote: { ...tx(BigInt(1)).quote, side, amountIn: amountIn.toString(), amountOut: String(Math.floor(amountOut)) } });
  it('accepts a quote at or above what the pool itself would pay, and up to 1% under', () => {
    const fill = (simulateBuy(deep.state, deep.dist, NVDA, 100).sharesOut) * 10 ** NVDA.decimals;
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), fill), NVDA, deep.state, deep.dist)).toBeNull();
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), fill * (1 - (MAX_FILL_GAP_BPS - 10) / 10000)), NVDA, deep.state, deep.dist)).toBeNull();
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), fill * 1.02), NVDA, deep.state, deep.dist)).toBeNull();
    const usdc = simulateSell(deep.state, deep.dist, NVDA, 0.5).usdcOut * 1e6;
    expect(poolFillProblem(withOut('sell', outRaw, usdc), NVDA, deep.state, deep.dist)).toBeNull();
  });
  it('refuses a quote more than 1% under the pool’s own fill, for buys and sells', () => {
    const fill = (simulateBuy(deep.state, deep.dist, NVDA, 100).sharesOut) * 10 ** NVDA.decimals;
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), fill * 0.98), NVDA, deep.state, deep.dist)).toMatch(/own pool would pay/);
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), 1), NVDA, deep.state, deep.dist)).toMatch(/own pool would pay/);
    expect(poolFillProblem(withOut('sell', outRaw, 1), NVDA, deep.state, deep.dist)).toMatch(/own pool would pay/);
  });
  it('accounts for depth: a thin pool fills well under spot, and that is not refused', () => {
    const thin = pool(BigInt(10) ** BigInt(9));
    const r = simulateBuy(thin.state, thin.dist, NVDA, 100);
    expect(r.costBp).toBeGreaterThan(300);
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), r.sharesOut * 10 ** NVDA.decimals), NVDA, thin.state, thin.dist)).toBeNull();
  });
  it('refuses an amount the pool cannot fill within its scanned window, and a pool listed the other way', () => {
    const tiny = pool(BigInt(1000));
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), 1e12), NVDA, tiny.state, tiny.dist)).toMatch(/try a smaller amount/);
    const flipped = { ...NVDA, pool: { ...NVDA.pool, token0: 'stock' as const } };
    expect(poolFillProblem(withOut('buy', BigInt(100_000_000), 1e12), flipped, deep.state, deep.dist)).toMatch(/not supported/);
  });
});
