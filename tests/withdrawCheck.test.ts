import { describe, expect, it } from 'vitest';
import { withdrawalProblem, type WithdrawalAsk } from '@/lib/baskets/withdrawCheck';

// Shapes copied from Glider's real stage-1 answers (2026-11-19, enrolled test wallet, nothing signed).
const OWNER = '0xf325610a2f9a0fB8BB92b472B8904349ea65C2ED';
const ACCOUNT = '0xa84fb3192449e3ea0c62135a4615a11efb32b64f';
const USDC = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NOW = 1795114229;
const plainTypes = {
  Withdrawal: [
    { name: 'portfolioId', type: 'string' },
    { name: 'recipientAccountId', type: 'string' },
    { name: 'assets', type: 'WithdrawalAsset[]' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint256' },
  ],
  WithdrawalAsset: [
    { name: 'assetId', type: 'string' },
    { name: 'amountRaw', type: 'string' },
  ],
};
const plain = () => ({
  primaryType: 'Withdrawal',
  domain: { name: 'Glider Withdrawal Authorization', version: '1', chainId: 8453, verifyingContract: ACCOUNT },
  types: structuredClone(plainTypes),
  message: {
    portfolioId: '451xjr1l',
    recipientAccountId: `eip155:8453:${OWNER.toLowerCase()}`,
    assets: [{ assetId: USDC, amountRaw: '1' }],
    nonce: '0x184257e3a0b834b8f2fdd08ce0af8bfd7abd6452ec2d79ec983408a00771608d',
    expiresAt: 1795114829,
  } as Record<string, unknown>,
});
const liquidating = () => {
  const t = plain();
  t.domain.version = '2';
  t.types.Withdrawal.push({ name: 'liquidate', type: 'bool' }, { name: 'settlementAssetId', type: 'string' });
  t.message.assets = [{ assetId: USDC, amountRaw: '1500000' }];
  t.message.liquidate = true;
  t.message.settlementAssetId = USDC;
  return t;
};
const ask = (o: Partial<WithdrawalAsk> = {}): WithdrawalAsk => ({
  owner: OWNER,
  accountId: `eip155:8453:${ACCOUNT}`,
  portfolioId: '451xjr1l',
  assets: [{ assetId: USDC, amountRaw: '1' }],
  liquidate: false,
  nowSec: NOW,
  ...o,
});
const askLiq = () => ask({ liquidate: true, assets: [{ assetId: USDC, amountRaw: '1500000' }] });

describe('withdrawalProblem', () => {
  it('accepts Glider’s real plain and liquidating withdrawals', () => {
    expect(withdrawalProblem(plain(), ask())).toBeNull();
    expect(withdrawalProblem(liquidating(), askLiq())).toBeNull();
  });
  it('refuses another recipient, portfolio, amount or asset', () => {
    const t1 = plain(); t1.message.recipientAccountId = 'eip155:8453:0x1111111111111111111111111111111111111111';
    expect(withdrawalProblem(t1, ask())).toMatch(/someone other/);
    const t2 = plain(); t2.message.recipientAccountId = `eip155:1:${OWNER}`;
    expect(withdrawalProblem(t2, ask())).toMatch(/someone other/);
    const t3 = plain(); t3.message.portfolioId = 'other';
    expect(withdrawalProblem(t3, ask())).toMatch(/another portfolio/);
    const t4 = plain(); t4.message.assets = [{ assetId: USDC, amountRaw: '2' }];
    expect(withdrawalProblem(t4, ask())).toMatch(/amounts/);
    const t5 = plain(); t5.message.assets = [{ assetId: USDC, amountRaw: '1' }, { assetId: USDC, amountRaw: '1' }];
    expect(withdrawalProblem(t5, ask())).toMatch(/assets/);
  });
  it('refuses another domain, chain, account or version', () => {
    const t1 = plain(); t1.domain.name = 'Kernel';
    expect(withdrawalProblem(t1, ask())).toMatch(/domain/);
    const t2 = plain(); t2.domain.chainId = 1;
    expect(withdrawalProblem(t2, ask())).toMatch(/Base/);
    const t3 = plain(); t3.domain.verifyingContract = '0x1111111111111111111111111111111111111111';
    expect(withdrawalProblem(t3, ask())).toMatch(/your Basis Tilt account/);
    expect(withdrawalProblem(plain(), ask({ liquidate: true }))).toMatch(/version/);
    const t4 = plain(); (t4.domain as Record<string, unknown>).salt = '0x' + '00'.repeat(32);
    expect(withdrawalProblem(t4, ask())).toMatch(/domain/);
  });
  it('refuses other typed data altogether (a permit, Kernel Enable)', () => {
    const permit = { primaryType: 'Permit', domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, types: { Permit: [] }, message: {} };
    expect(withdrawalProblem(permit, ask())).toMatch(/not a withdrawal/);
    const enable = plain() as Record<string, unknown>; enable.primaryType = 'Enable';
    expect(withdrawalProblem(enable, ask())).toMatch(/not a withdrawal/);
    expect(withdrawalProblem(null, ask())).toMatch(/format/);
  });
  it('refuses added or changed fields and types', () => {
    const t1 = plain(); t1.message.extra = 'x';
    expect(withdrawalProblem(t1, ask())).toMatch(/fields/);
    const t2 = plain(); t2.types.Withdrawal[1].type = 'address';
    expect(withdrawalProblem(t2, ask())).toMatch(/fields/);
  });
  it('refuses a bad nonce or expiry', () => {
    const t1 = plain(); t1.message.nonce = '0x12';
    expect(withdrawalProblem(t1, ask())).toMatch(/nonce/);
    // A device clock a few minutes off still works; far off or a long validity is refused.
    expect(withdrawalProblem(plain(), ask({ nowSec: 1795114829 + 120 }))).toBeNull();
    expect(withdrawalProblem(plain(), ask({ nowSec: 1795114829 - 3000 }))).toBeNull();
    expect(withdrawalProblem(plain(), ask({ nowSec: 1795114829 + 600 }))).toMatch(/clock/);
    const t2 = plain(); t2.message.expiresAt = NOW + 2 * 3600;
    expect(withdrawalProblem(t2, ask())).toMatch(/clock/);
    const t3 = plain(); t3.message.expiresAt = '1795114829';
    expect(withdrawalProblem(t3, ask())).toMatch(/malformed/);
  });
  it('matches several assets in any order, refusing duplicates or a changed amount', () => {
    const NVDA = 'eip155:8453/erc20:0xb20000000000000000000078ee7ce2fe4908108c';
    const two = [{ assetId: USDC, amountRaw: '1' }, { assetId: NVDA, amountRaw: '5' }];
    const t1 = plain(); t1.message.assets = [two[1], two[0]];
    expect(withdrawalProblem(t1, ask({ assets: two }))).toBeNull();
    const t2 = plain(); t2.message.assets = [two[0], two[0]];
    expect(withdrawalProblem(t2, ask({ assets: two }))).toMatch(/repeat/);
    const t3 = plain(); t3.message.assets = [two[0], { assetId: NVDA.toUpperCase().replace('EIP155', 'eip155'), amountRaw: '6' }];
    expect(withdrawalProblem(t3, ask({ assets: two }))).toMatch(/amounts/);
  });
  it('refuses a liquidation that settles elsewhere or doesn’t liquidate', () => {
    const t1 = liquidating(); t1.message.settlementAssetId = 'eip155:8453/erc20:0x1111111111111111111111111111111111111111';
    expect(withdrawalProblem(t1, askLiq())).toMatch(/USDC on Base/);
    const t2 = liquidating(); t2.message.liquidate = false;
    expect(withdrawalProblem(t2, askLiq())).toMatch(/sell into USDC/);
  });
});
