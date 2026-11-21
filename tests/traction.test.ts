import { describe, expect, it } from 'vitest';
import { summarizeSwaps, type SwapRecord } from '../lib/swap/swapLog';
import { testWalletIds, walletId } from '../lib/swap/testWallets';

// The traction numbers leave Afterbook's own test wallets out, say how much they left out, and list the newest
// agent-link swaps by hash without the wallet.
const OWNER = '0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae';
const OTHER_TEST = '0x00000000000000000000000000000000000000aa';
const rec = (wallet: string, usd: number, source: SwapRecord['source'], at = 1, hash = `0x${at.toString(16).padStart(64, '0')}`): SwapRecord => ({
  hash, at, symbol: 'NVDAc', side: 'buy', usd, feeBps: 0, feeUsd: 0, wallet: walletId(wallet), source,
});

describe('test wallets', () => {
  it('always include the owner’s wallet, and take addresses or wallet ids from the env, ignoring junk', () => {
    expect(testWalletIds('').has(walletId(OWNER))).toBe(true);
    expect(testWalletIds(OWNER.toLowerCase()).size).toBe(1);
    const ids = testWalletIds(` ${OTHER_TEST} , ABCDEF0123456789, nope, 0x12 `);
    expect(ids.has(walletId(OTHER_TEST))).toBe(true);
    expect(ids.has('abcdef0123456789')).toBe(true);
    expect(ids.size).toBe(3);
  });
});

describe('traction numbers', () => {
  const records = [
    rec(OWNER, 100, 'stock', 1),
    rec(OTHER_TEST, 50, 'agent', 2),
    rec('0x1111111111111111111111111111111111111111', 20, 'agent', 3, `0x${'3'.repeat(64)}:1`),
    rec('0x1111111111111111111111111111111111111111', 30, 'plan', 4),
    rec('0x2222222222222222222222222222222222222222', 40, 'stock', 5),
  ];
  const ids = testWalletIds(OTHER_TEST);

  it('leave test wallets out and report what was left out', () => {
    const s = summarizeSwaps(records, 30, ids);
    expect([s.swaps, s.volumeUsd, s.traders]).toEqual([3, 90, 2]);
    expect(s.testsLeftOut).toEqual({ swaps: 2, volumeUsd: 150 });
    expect(s.bySource.agent).toEqual({ swaps: 1, volumeUsd: 20, traders: 1 });
    expect(s.bySource.stock.swaps).toBe(1);
  });

  it('include them only when asked', () => {
    const s = summarizeSwaps(records, 30, ids, true);
    expect([s.swaps, s.testsLeftOut]).toEqual([5, null]);
  });

  it('list agent-link swaps newest first, by transaction hash, with no wallet', () => {
    const s = summarizeSwaps(records, 30, ids);
    expect(s.recentAgentLinkSwaps).toEqual([{ hash: `0x${'3'.repeat(64)}`, at: 3, symbol: 'NVDAc', side: 'buy', usd: 20 }]);
    expect(JSON.stringify(s.recentAgentLinkSwaps)).not.toContain('wallet');
  });
});
