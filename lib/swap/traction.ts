// The public traction page's numbers (/traction, 2026-11-21): swaps signed through Afterbook and found
// onchain with its Builder Code (the swap log, lib/swap/swapLog.ts), test wallets left out
// (lib/swap/testWallets.ts), and paid x402 calls (lib/server/x402Ledger.ts). Read through Next's data cache for an
// hour, so views don't each cost Redis requests (two for the swaps, one for the paid calls).
import 'server-only';
import { unstable_cache } from 'next/cache';
import { swapRecords, summarizeSwaps, type SwapStats } from './swapLog';
import { testWalletIds } from './testWallets';
import { last30Days, paidCalls, summarizePaidCalls, type PaidCallStats } from '../server/x402Ledger';

const DAY = 86_400_000;

export interface Traction {
  month: SwapStats;
  /** Since the log began (records are kept 400 days). */
  all: SwapStats;
  /** When the oldest counted swap was signed; null with none. */
  sinceMs: number | null;
  /** x402 calls paid and settled onchain (lib/server/x402Ledger.ts); null when the ledger couldn't be read. */
  paid: { month: PaidCallStats; all: PaidCallStats } | null;
  at: number;
}

export async function computeTraction(now = Date.now()): Promise<Traction | null> {
  const [records, calls] = await Promise.all([swapRecords(400), paidCalls().catch(() => null)]);
  if (!records) return null;
  const ids = testWalletIds();
  const all = summarizeSwaps(records, 400, ids);
  const counted = records.filter((r) => !ids.has(r.wallet));
  return {
    month: summarizeSwaps(
      records.filter((r) => r.at >= now - 30 * DAY),
      30,
      ids,
    ),
    all,
    sinceMs: counted.length ? Math.min(...counted.map((r) => r.at)) : null,
    paid: calls ? { month: summarizePaidCalls(calls, last30Days(now)), all: summarizePaidCalls(calls) } : null,
    at: now,
  };
}

// v3 (2026-11-25): `paid` added; a new key so a cached v2 result (without it) is never read.
export const getTraction = unstable_cache(() => computeTraction(), ['traction-v3'], { revalidate: 3600 });
