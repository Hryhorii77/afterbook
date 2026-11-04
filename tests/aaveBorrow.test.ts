// The in-app Aave borrow's maths and calls (lib/lending/aaveBorrow.ts): what "Max" allows, the health factor
// shown before signing, and that every call is on behalf of the signer.
import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  borrowCalls,
  borrowPowerUsd,
  fallToLiquidation,
  healthFactor,
  LIMIT_MARGIN,
  lendWithdrawArg,
  MAX_LEND_USD,
  MAX_UINT256,
  maxLendWithdrawRaw,
  MAX_BORROW_USD,
  maxBorrowRaw,
  maxWithdrawRaw,
  repayAllApproval,
  SPOKE_ABI,
  withChange,
  type AavePosition,
  type AaveReserve,
} from '../lib/lending/aaveBorrow';

const NVDA: AaveReserve = { reserveId: 3, symbol: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fe4908108c', decimals: 8, collateralFactor: 0.7 };
const AAPL: AaveReserve = { reserveId: 1, symbol: 'AAPLc', token: '0xb200000000000000000000c2e324d24d7eecd1fb', decimals: 8, collateralFactor: 0.78 };
const USDC: AaveReserve = { reserveId: 0, symbol: 'USDC', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, collateralFactor: 0 };
const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const tokens = (n: number) => BigInt(Math.round(n * 1e8));
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

// 10 NVDAc at $200 (cf 0.7) = $1,400 of borrow power; $700 borrowed: health 2.0.
const pos = (debt = 700, enabled = true): AavePosition => ({
  collateral: [
    { reserve: NVDA, suppliedRaw: tokens(10), enabled, priceUsd: 200 },
    { reserve: AAPL, suppliedRaw: BigInt(0), enabled: false, priceUsd: 250 },
  ],
  debtRaw: usdc(debt),
});

describe('health', () => {
  it('weights collateral by its factor and ignores reserves not enabled as collateral', () => {
    expect(borrowPowerUsd(pos())).toBeCloseTo(1400);
    expect(borrowPowerUsd(pos(700, false))).toBe(0);
  });
  it('health factor and the fall that liquidates', () => {
    expect(healthFactor(pos())).toBeCloseTo(2);
    expect(fallToLiquidation(pos())).toBeCloseTo(0.5);
    expect(healthFactor(pos(0))).toBe(Infinity);
    expect(fallToLiquidation(pos(0))).toBeNull();
  });
  it('projects adding collateral (turning it on) and borrowing', () => {
    const next = withChange(pos(), { reserveId: AAPL.reserveId, addRaw: tokens(4), borrowRaw: usdc(300) });
    // + 4 × 250 × 0.78 = 780 → 2,180 power over 1,000 debt
    expect(borrowPowerUsd(next)).toBeCloseTo(2180);
    expect(healthFactor(next)).toBeCloseTo(2.18);
  });
});

describe('max borrow', () => {
  it('is the protocol limit less the margin', () => {
    expect(Number(maxBorrowRaw(pos(), 1e9)) / 1e6).toBeCloseTo(1400 * (1 - LIMIT_MARGIN) - 700, 4);
  });
  it('is capped by the $25k rule and the pool', () => {
    const rich: AavePosition = { collateral: [{ reserve: NVDA, suppliedRaw: tokens(1000), enabled: true, priceUsd: 200 }], debtRaw: BigInt(0) };
    expect(Number(maxBorrowRaw(rich, 1e9)) / 1e6).toBe(MAX_BORROW_USD);
    expect(Number(maxBorrowRaw(rich, 1234.5)) / 1e6).toBeCloseTo(1234.5);
  });
  it('is zero over the limit', () => {
    expect(maxBorrowRaw(pos(1400), 1e9)).toBe(BigInt(0));
  });
});

describe('max withdraw', () => {
  it('is everything with no debt', () => {
    expect(maxWithdrawRaw(pos(0), NVDA.reserveId)).toBe(tokens(10));
  });
  it('keeps the position within the limit (less the margin)', () => {
    const w = maxWithdrawRaw(pos(), NVDA.reserveId);
    const after = withChange(pos(), { reserveId: NVDA.reserveId, withdrawRaw: w });
    expect(borrowPowerUsd(after) * (1 - LIMIT_MARGIN)).toBeGreaterThanOrEqual(700 - 1e-6);
    expect(Number(w) / 1e8).toBeGreaterThan(4.9);
    expect(Number(w) / 1e8).toBeLessThan(5);
  });
  it('is zero for a reserve with nothing supplied', () => {
    expect(maxWithdrawRaw(pos(), AAPL.reserveId)).toBe(BigInt(0));
  });
});

describe('repay all approval', () => {
  it('is the debt plus 1 bp plus one unit', () => {
    expect(repayAllApproval(usdc(1000))).toBe(usdc(1000) + BigInt(100_000) + BigInt(1));
  });
});

describe('borrowCalls', () => {
  const decode = (d: `0x${string}`) => decodeFunctionData({ abi: SPOKE_ABI, data: d });
  it('supplies, turns collateral on and borrows, all on behalf of the signer', () => {
    const calls = borrowCalls(ACCOUNT, { stock: NVDA, addRaw: tokens(2), enableCollateral: true, usdc: USDC, borrowRaw: usdc(100) }).map(decode);
    expect(calls.map((c) => c.functionName)).toEqual(['supply', 'setUsingAsCollateral', 'borrow']);
    expect(calls[0].args).toEqual([BigInt(3), tokens(2), ACCOUNT]);
    expect(calls[1].args).toEqual([BigInt(3), true, ACCOUNT]);
    expect(calls[2].args).toEqual([BigInt(0), usdc(100), ACCOUNT]);
  });
  it('skips what is not asked for', () => {
    expect(borrowCalls(ACCOUNT, { usdc: USDC, borrowRaw: usdc(5) }).map((c) => decode(c).functionName)).toEqual(['borrow']);
    expect(borrowCalls(ACCOUNT, { stock: NVDA, addRaw: tokens(1), enableCollateral: false, usdc: USDC }).map((c) => decode(c).functionName)).toEqual(['supply']);
  });
});

describe('USDC priced by the oracle', () => {
  it('values debt at the oracle USDC price, as Aave does', () => {
    const p = { ...pos(), usdcPriceUsd: 1.004 };
    expect(healthFactor(p)).toBeCloseTo(1400 / (700 * 1.004));
    // Max borrow keeps the projected value within the margin at that price.
    const max = maxBorrowRaw(p, 1e9);
    const after = withChange(p, { borrowRaw: max });
    expect(healthFactor(after)).toBeGreaterThanOrEqual(1 / (1 - LIMIT_MARGIN) - 1e-9);
  });
});

describe('lending', () => {
  it('withdraw is capped by what the pool has free', () => {
    expect(maxLendWithdrawRaw(usdc(100), usdc(1_000))).toBe(usdc(100));
    expect(maxLendWithdrawRaw(usdc(5_000), usdc(1_000))).toBe(usdc(1_000));
    expect(maxLendWithdrawRaw(BigInt(0), usdc(1_000))).toBe(BigInt(0));
  });
  it('sends MAX only for a full withdrawal the pool can pay', () => {
    expect(lendWithdrawArg(usdc(100), usdc(100), usdc(1_000))).toBe(MAX_UINT256);
    expect(lendWithdrawArg(usdc(50), usdc(100), usdc(1_000))).toBe(usdc(50));
    // Pool short: never MAX (it would revert anyway); the exact amount the panel allowed.
    expect(lendWithdrawArg(usdc(1_000), usdc(5_000), usdc(1_000))).toBe(usdc(1_000));
    // Pool only just covers it: the exact amount, so fresh interest can't make MAX revert.
    expect(lendWithdrawArg(usdc(100), usdc(100), usdc(100.5))).toBe(usdc(100));
  });
  it('caps a deposit at $25k', () => {
    expect(MAX_LEND_USD).toBe(25_000);
  });
});
