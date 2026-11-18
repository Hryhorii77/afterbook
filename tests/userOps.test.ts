// userOpOutcome decides whether a mined transaction did what the person signed. For a smart account the
// bundler's transaction can succeed while the account's own operation reverted (a real AMZNc sale on
// 2026-11-18 showed "sold" though nothing was sold).
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from 'viem';
import { entryPoint06Abi } from 'viem/account-abstraction';
import { userOpOutcome } from '../lib/wallet/userOps';

const EP = getAddress('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
const ME = getAddress('0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae');
const OTHER = getAddress('0x3333333333333333333333333333333333333333');
const ROUTER = getAddress('0x6131B5fae19EA4f9D964eAc0408E4408b66337b5');

function opEvent(sender: Hex, success: boolean, address: Hex = EP) {
  const topics = encodeEventTopics({ abi: entryPoint06Abi, eventName: 'UserOperationEvent', args: { userOpHash: ('0x' + '01'.repeat(32)) as Hex, sender, paymaster: '0x0000000000000000000000000000000000000000' } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(1), success, BigInt(1), BigInt(1)]);
  return { address, topics: topics as Hex[], data };
}

describe('userOpOutcome', () => {
  it('reads a straight transaction by its status', () => {
    expect(userOpOutcome({ status: 'success', to: ROUTER, logs: [] }, ME)).toBe('success');
    expect(userOpOutcome({ status: 'reverted', to: ROUTER, logs: [] }, ME)).toBe('reverted');
  });
  it("reads a bundler's transaction by the account's own user operation", () => {
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(ME, true)] }, ME)).toBe('success');
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(ME, false)] }, ME)).toBe('reverted');
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(OTHER, true), opEvent(ME, false)] }, ME)).toBe('reverted');
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(OTHER, false), opEvent(ME, true)] }, ME)).toBe('success');
  });
  it("can't tell when the bundle holds no operation for the account, or the account isn't known", () => {
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(OTHER, true)] }, ME)).toBe('unknown');
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(ME, true)] }, undefined)).toBe('unknown');
  });
  it('ignores an event that looks like the EntryPoint\'s but comes from another contract', () => {
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(ME, true, OTHER)] }, ME)).toBe('unknown');
    expect(userOpOutcome({ status: 'success', to: ROUTER, logs: [opEvent(ME, false, OTHER)] }, ME)).toBe('success');
  });
  it("reads a wallet's batch receipt (no `to`) by its status and the account's operation when present", () => {
    expect(userOpOutcome({ status: 'success', logs: [] }, ME)).toBe('success');
    expect(userOpOutcome({ status: 'success', logs: [opEvent(ME, false)] }, ME)).toBe('reverted');
  });
  it('reads two operations of the account with different results as unknown, and other accounts\' events without `to` as unknown', () => {
    expect(userOpOutcome({ status: 'success', to: EP, logs: [opEvent(ME, true), opEvent(ME, false)] }, ME)).toBe('unknown');
    expect(userOpOutcome({ status: 'success', logs: [opEvent(OTHER, true)] }, ME)).toBe('unknown');
    expect(userOpOutcome({ status: 'success', logs: [opEvent(OTHER, false)] }, ME)).toBe('unknown');
  });
});
