import { redis } from './redis';

// B20's multiplier() isn't split-only, despite how lib/quote.ts originally
// described it — Base's own B20 spec documents cash dividends being
// reinvested into additional shares by raising the multiplier, net of
// withholding tax and a Coinbase fee. So a real dividend or split is fully
// detectable with zero new external dependency: just notice when a stock's
// multiplier changes from its last known value. Mirrors lib/discovery.ts's
// admin-notify pattern (a human should glance at this, not a per-user
// configurable alert — see lib/alerts.ts for that different shape) rather
// than auto-publishing an unverified inference.

const MULTIPLIER_ONE = 1e18;

// Multiplier essentially never changes (all ten read exactly 1.0x today) —
// checking every single tape build (every ~20s of live traffic) would be a
// Redis read on every request for no benefit, so this throttles the same
// way lib/history.ts's recordSample does.
const CHECK_INTERVAL_MS = 5 * 60_000;
const lastCheckMs = new Map<string, number>();

export interface MultiplierChange {
  from: number;
  to: number;
}

/** First observation for a symbol establishes the baseline and returns
 *  null — not a "change", nothing to compare against yet. */
export async function checkMultiplierChange(symbol: string, currentMultiplier: bigint, now: number): Promise<MultiplierChange | null> {
  if (!redis) return null;

  const last = lastCheckMs.get(symbol) ?? 0;
  if (now - last < CHECK_INTERVAL_MS) return null;
  lastCheckMs.set(symbol, now);

  const key = `multiplier:${symbol}`;
  try {
    const stored = await redis.get<string>(key);
    if (stored == null) {
      await redis.set(key, currentMultiplier.toString());
      return null;
    }

    const storedMultiplier = BigInt(stored);
    if (storedMultiplier === currentMultiplier) return null;

    await redis.set(key, currentMultiplier.toString());
    return {
      from: Number(storedMultiplier) / MULTIPLIER_ONE,
      to: Number(currentMultiplier) / MULTIPLIER_ONE,
    };
  } catch {
    return null;
  }
}
