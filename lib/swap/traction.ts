// The public traction page's numbers (/traction, 2026-11-21): swaps signed through Afterbook and found
// onchain with its Builder Code (the swap log, lib/swap/swapLog.ts), test wallets left out
// (lib/swap/testWallets.ts), and paid agent plans. Read through Next's data cache for an hour, so views
// don't each cost Redis requests (two for the swaps, one pipeline of 30 for the plans).
import 'server-only';
import { unstable_cache } from 'next/cache';
import { swapRecords, summarizeSwaps, type SwapStats } from './swapLog';
import { testWalletIds } from './testWallets';
import { planStats } from '../agent/planStats';

const DAY = 86_400_000;

export interface Traction {
  month: SwapStats;
  /** Since the log began (records are kept 400 days). */
  all: SwapStats;
  /** When the oldest counted swap was signed; null with none. */
  sinceMs: number | null;
  /** Plans agents paid for over x402 in the last 30 days (planStats `paid`). */
  paidPlans30: number | null;
  at: number;
}

export async function computeTraction(now = Date.now()): Promise<Traction | null> {
  const [records, plans] = await Promise.all([swapRecords(400), planStats(30, now).catch(() => null)]);
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
    paidPlans30: plans?.total.paid ?? null,
    at: now,
  };
}

export const getTraction = unstable_cache(() => computeTraction(), ['traction-v1'], { revalidate: 3600 });
