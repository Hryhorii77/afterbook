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
export const LIQUID_DEPTH_THRESHOLD_USD = 100_000;

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
