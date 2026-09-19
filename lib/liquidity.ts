// Pure, dependency-free classification helper — deliberately its own module
// (not part of lib/tape.ts) so client components can import it without
// pulling lib/tape.ts's server-only dependencies (viem, the RPC client) into
// the browser bundle.
//
// A basis reading off a $10k pool swings hundreds of bp on noise alone and
// reads as "the tape is broken" next to a $2M pool's single-digit bp — same
// visual weight, wildly different meaning. Split on real depth rather than a
// hardcoded symbol list so a thin pool automatically graduates once it
// actually has liquidity, instead of needing a code change forever.
//
// $100k wasn't tight enough in practice: `depthUsd` is the pool's total real
// token balance, not liquidity active near the current tick, so a pool can
// clear $100k on stale/off-range positions while still swinging hundreds of
// bp — MSTRc cleared this at ~$965k depth while sitting at +257bp, still
// screaming "broken" in the hero next to single-digit-bp names. $1M is where
// today's ten pools actually split into a calm tier and a still-noisy one.
export const LIQUID_DEPTH_THRESHOLD_USD = 1_000_000;

interface HasDepth {
  depthUsd: number | null;
}

export function isLiquid(row: HasDepth): boolean {
  return row.depthUsd != null && row.depthUsd >= LIQUID_DEPTH_THRESHOLD_USD;
}

export function splitByLiquidity<T extends HasDepth>(rows: T[]): { liquid: T[]; thin: T[] } {
  const liquid: T[] = [];
  const thin: T[] = [];
  for (const row of rows) {
    (isLiquid(row) ? liquid : thin).push(row);
  }
  return { liquid, thin };
}
