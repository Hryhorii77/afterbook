import { describe, expect, it } from 'vitest';
import { afterFeeReserve, leavesNoFeeRoom, USDC_FEE_RESERVE_RAW } from '../lib/wallet/feeReserve';
import { reachesBlock } from '../lib/swap/dryRun';
import { repayAllApproval, repayAllApprovalNow } from '../lib/lending/aaveBorrow';

// Follow-ups of 2026-11-25: Base Account's USDC fee reserve, the dry run's wait for the approval's block, and a
// full repay's approval from the debt read again before signing.
const usdc = (n: number) => BigInt(Math.round(n * 1e6));

describe('USDC fee reserve', () => {
  it('Max keeps $0.05 back, never below zero', () => {
    expect(USDC_FEE_RESERVE_RAW).toBe(usdc(0.05));
    expect(afterFeeReserve(usdc(11.044046))).toBe(usdc(10.994046));
    expect(afterFeeReserve(usdc(0.05))).toBe(BigInt(0));
    expect(afterFeeReserve(usdc(0.01))).toBe(BigInt(0));
    expect(afterFeeReserve(BigInt(0))).toBe(BigInt(0));
  });
  it('the note shows only for an amount that leaves less than the reserve and fits the balance', () => {
    expect(leavesNoFeeRoom(usdc(11.044), usdc(11.044))).toBe(true);
    expect(leavesNoFeeRoom(usdc(11.0), usdc(11.044))).toBe(true);
    expect(leavesNoFeeRoom(usdc(10.994), usdc(11.044))).toBe(false);
    expect(leavesNoFeeRoom(usdc(12), usdc(11.044))).toBe(false); // over the balance: its own message
    expect(leavesNoFeeRoom(BigInt(0), usdc(0.01))).toBe(false);
  });
});

describe('dry run after an approval waits for its block', () => {
  const node = (heads: number[]) => {
    let i = 0;
    const reads: number[] = [];
    return { head: async () => BigInt(heads[Math.min(i++, heads.length - 1)]), reads, sleeps: [] as number[] };
  };
  it('true at once when the node already has the block', async () => {
    const n = node([100]);
    expect(await reachesBlock(n.head, BigInt(100), 4, 1000, async (ms) => void n.sleeps.push(ms))).toBe(true);
    expect(n.sleeps).toEqual([]);
  });
  it('waits for a node a little behind', async () => {
    const n = node([98, 99, 100]);
    expect(await reachesBlock(n.head, BigInt(100), 4, 1000, async (ms) => void n.sleeps.push(ms))).toBe(true);
    expect(n.sleeps).toEqual([1000, 1000]);
  });
  it('gives up after four pauses on a node still behind (its answer then never blocks a swap)', async () => {
    const n = node([90]);
    expect(await reachesBlock(n.head, BigInt(100), 4, 1000, async (ms) => void n.sleeps.push(ms))).toBe(false);
    expect(n.sleeps).toHaveLength(4);
  });
});

describe('a full repay’s approval', () => {
  it('uses the larger of the page’s debt and the one read again, capped by the wallet', () => {
    // A tab left open: the debt has grown since the page read it.
    expect(repayAllApprovalNow(usdc(4.5), usdc(4.6), usdc(100))).toEqual({ approval: repayAllApproval(usdc(4.6)), cap: repayAllApproval(usdc(4.6)) });
    // The fresh read failed, or (never in practice) came back lower: the page's figure.
    expect(repayAllApprovalNow(usdc(4.5), null, usdc(100)).cap).toBe(repayAllApproval(usdc(4.5)));
    expect(repayAllApprovalNow(usdc(4.5), usdc(4.4), usdc(100)).cap).toBe(repayAllApproval(usdc(4.5)));
    // Never more than the wallet holds; the cap the batch check uses stays the debt plus the buffer.
    const tight = repayAllApprovalNow(usdc(4.5), usdc(4.5), usdc(4.5));
    expect(tight.approval).toBe(usdc(4.5));
    expect(tight.approval <= tight.cap).toBe(true);
  });
  it('with the wallet holding the debt but not the buffer, the capped approval is the whole balance: the fee note applies', () => {
    const debt = usdc(4.5);
    const balance = debt + BigInt(100); // over the debt, under debt + buffer
    const { approval } = repayAllApprovalNow(debt, null, balance);
    expect(approval).toBe(balance);
    expect(leavesNoFeeRoom(approval, balance)).toBe(true);
  });
});
