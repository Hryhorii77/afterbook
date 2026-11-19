import { describe, expect, it } from 'vitest';
import { deployedAccountProblem, depositAccountProblem, findGliderSalt, gliderKernelAddress, KERNEL_V3_1_IMPLEMENTATION } from '@/lib/baskets/depositAccount';

// Real Glider accounts on Base (2026-11-19): two deployed, one not yet deployed.
const OWNER_A = '0xf325610a2f9a0fB8BB92b472B8904349ea65C2ED';
const OWNER_B = '0x7e8ba8a0ed567e1e048d590c27f6e0ce8e90308f';
const ACCT_A1 = '0xa84fb3192449e3ea0c62135a4615a11efb32b64f'; // salt 0x8b0329, deployed
const ACCT_A2 = '0xb6bbb27f8cbe3e882d36028b7f7828ffb8367b0f'; // salt 0x8b032a, deployed
const ACCT_B = '0x3da1e1330c62da3720e2b9afc29485cc153de010'; // salt 0x8b0335, not deployed
const id = (a: string) => ({ accountId: `eip155:8453:${a}` });

describe('gliderKernelAddress', () => {
  it('recomputes real accounts from owner and salt', () => {
    expect(gliderKernelAddress(OWNER_A, BigInt(0x8b0329)).toLowerCase()).toBe(ACCT_A1);
    expect(gliderKernelAddress(OWNER_A, BigInt(0x8b032a)).toLowerCase()).toBe(ACCT_A2);
    expect(gliderKernelAddress(OWNER_B, BigInt(0x8b0335)).toLowerCase()).toBe(ACCT_B);
  });
  it('finds the salt by scanning', () => {
    expect(findGliderSalt(OWNER_B, ACCT_B)).toBe(BigInt(0x8b0335));
    expect(findGliderSalt(OWNER_B, ACCT_A1)).toBeNull();
  });
});

describe('depositAccountProblem', () => {
  it('accepts the wallet’s own account, deployed or not, in any case', () => {
    expect(depositAccountProblem(OWNER_A, id(ACCT_A1))).toBeNull();
    expect(depositAccountProblem(OWNER_A.toLowerCase(), id(ACCT_A2.toUpperCase().replace('0X', '0x')))).toBeNull();
    expect(depositAccountProblem(OWNER_B, id(ACCT_B))).toBeNull();
    expect(depositAccountProblem(OWNER_A, { ...id(ACCT_A1), depositAccountId: `eip155:8453:${ACCT_A1}` })).toBeNull();
  });
  it('refuses another owner’s account', () => {
    expect(depositAccountProblem(OWNER_B, id(ACCT_A1))).toMatch(/could not be confirmed/);
    expect(depositAccountProblem(OWNER_A, id(ACCT_B))).toMatch(/could not be confirmed/);
  });
  it('refuses any other address', () => {
    expect(depositAccountProblem(OWNER_A, id('0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae'))).toMatch(/could not be confirmed/);
    expect(depositAccountProblem(OWNER_A, id('0x1234'))).toMatch(/malformed/);
  });
  it('refuses another chain, a separate deposit address, or no account', () => {
    expect(depositAccountProblem(OWNER_A, { accountId: `eip155:1:${ACCT_A1}` })).toMatch(/Base account/);
    expect(depositAccountProblem(OWNER_A, { ...id(ACCT_A1), depositAccountId: `eip155:8453:${ACCT_B}` })).toMatch(/not the account itself/);
    expect(depositAccountProblem(OWNER_A, undefined)).toMatch(/Base account/);
    expect(depositAccountProblem(undefined, id(ACCT_A1))).toMatch(/Connect/);
  });
  it('treats a null depositAccountId as absent and refuses non-strings without throwing', () => {
    expect(depositAccountProblem(OWNER_A, { ...id(ACCT_A1), depositAccountId: null })).toBeNull();
    expect(depositAccountProblem(OWNER_A, { ...id(ACCT_A1), depositAccountId: 5 })).toMatch(/not the account itself/);
    expect(depositAccountProblem(OWNER_A, { accountId: null })).toMatch(/Base account/);
  });
});

describe('deployedAccountProblem', () => {
  const ROOT = '0x015c97aa67ba578e3c54ec5942a7563ea9130e4f5f';
  const slot = (impl: string) => ('0x' + '0'.repeat(24) + impl.slice(2).toLowerCase()) as `0x${string}`;
  const client = (o: { code?: string; impl?: string; root?: string; signer?: string; fail?: boolean }) => ({
    getCode: async () => (o.fail ? Promise.reject(new Error('rpc')) : (o.code ?? '0x363d')) as `0x${string}`,
    getStorageAt: async () => slot(o.impl ?? KERNEL_V3_1_IMPLEMENTATION),
    readContract: (async ({ functionName }: { functionName: string }) => (functionName === 'rootValidator' ? o.root ?? ROOT : o.signer ?? OWNER_A)) as never,
  });
  it('passes an undeployed account and a deployed one still set up as created', async () => {
    expect(await deployedAccountProblem(client({ code: '0x' }), OWNER_A, ACCT_A1)).toBeNull();
    expect(await deployedAccountProblem(client({}), OWNER_A, ACCT_A1)).toBeNull();
  });
  it('refuses another implementation, root validator or signer', async () => {
    expect(await deployedAccountProblem(client({ impl: '0x1111111111111111111111111111111111111111' }), OWNER_A, ACCT_A1)).toMatch(/no longer set up/);
    expect(await deployedAccountProblem(client({ root: '0x021111111111111111111111111111111111111111' }), OWNER_A, ACCT_A1)).toMatch(/no longer set up/);
    expect(await deployedAccountProblem(client({ signer: OWNER_B }), OWNER_A, ACCT_A1)).toMatch(/no longer set up/);
  });
  it('fails closed when the chain cannot be read', async () => {
    expect(await deployedAccountProblem(client({ fail: true }), OWNER_A, ACCT_A1)).toMatch(/Couldn.t read/);
  });
});
