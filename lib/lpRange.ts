// Capital efficiency of a concentrated-liquidity range vs. a full-range
// (Uniswap V2-style) position holding the same USD value — derived
// directly from the same virtual-reserve equations lib/quote.ts already
// uses and this app already verifies against real on-chain pool state,
// not a recalled closed-form. For a range [Pa, Pb] bracketing current
// price P (Pa <= P <= Pb):
//
//   amount0(L) = L * (1/sqrt(P) - 1/sqrt(Pb))   [USDC-like]
//   amount1(L) = L * (sqrt(P) - sqrt(Pa))         [stock-like]
//   value(L)   = amount0(L) + amount1(L) * P      [USD]
//
// Capital efficiency = value_fullRange(L) / value_range(L) for the same L
// (equivalently, how much more liquidity the same $ deposit buys in the
// narrower range). Normalizing P=1 (i.e. working in price-ratios relative
// to current price) makes this scale-free and reduces algebraically to:
//
//   multiplier = 2 / (2 - sqrt(Pa/P) - sqrt(P/Pb))
//
// Verified numerically against the unreduced form before trusting this
// (see the session's own numeric check) — asymptotes to 1 as the range
// widens to (0, inf) and to infinity as it narrows to a point, both as
// expected.
export function capitalEfficiencyMultiplier(rangeLowUsd: number, rangeHighUsd: number, currentPriceUsd: number): number | null {
  if (rangeLowUsd <= 0 || rangeHighUsd <= rangeLowUsd || currentPriceUsd <= 0) return null;
  if (rangeLowUsd > currentPriceUsd || rangeHighUsd < currentPriceUsd) return null; // out-of-range: this formula assumes P is bracketed

  const pLowRatio = rangeLowUsd / currentPriceUsd;
  const pHighRatio = rangeHighUsd / currentPriceUsd;
  const denom = 2 - Math.sqrt(pLowRatio) - 1 / Math.sqrt(pHighRatio);
  if (denom <= 0) return null; // degenerate range, shouldn't happen once clamped by the UI
  return 2 / denom;
}

export interface LiquidityBucketLike {
  tickLower: number;
  tickUpper: number;
  priceLowerUsd: number;
  priceUpperUsd: number;
  liquidity: string;
}

export interface LiquidityConcentrationRange {
  lowUsd: number;
  highUsd: number;
  /** Fraction actually captured, 0-1 — a discrete bucket walk can't hit
   *  targetFraction exactly, so callers that need a probability to match
   *  against (e.g. solveImpliedHorizonDays) should use this, not the
   *  original target. */
  actualFraction: number;
}

/**
 * The price range around current price containing the highest-density
 * targetFraction of the pool's scanned liquidity (lib/depth.ts's tick
 * buckets, passed in as plain data so this stays a dependency-free pure
 * module a client component can import without pulling in lib/depth.ts's
 * own lib/quote.ts -> viem chain) — a real, on-chain observation of where
 * LPs have actually concentrated capital, not a synthetic "implied
 * volatility" (there's no options market here to price one). Constructed
 * as a proper highest-density region: each bucket's *density* in tick-
 * space is exactly its own liquidity value (mass = liquidity × tickWidth
 * by construction, so density = mass / tickWidth = liquidity), so
 * greedily adding whichever neighboring bucket has higher liquidity
 * first — rather than just walking outward by tick distance — gives the
 * minimal-width interval capturing that much mass, the standard HDR
 * construction.
 */
export function computeLiquidityConcentrationRange(
  buckets: LiquidityBucketLike[],
  currentTick: number,
  targetFraction: number,
): LiquidityConcentrationRange | null {
  if (buckets.length === 0 || targetFraction <= 0 || targetFraction >= 1) return null;

  const mass = buckets.map((b) => Number(b.liquidity) * (b.tickUpper - b.tickLower));
  const totalMass = mass.reduce((a, b) => a + b, 0);
  if (totalMass <= 0) return null;

  const centerIdx = buckets.findIndex((b) => b.tickLower <= currentTick && currentTick < b.tickUpper);
  if (centerIdx < 0) return null;

  let loIdx = centerIdx;
  let hiIdx = centerIdx;
  let accumulated = mass[centerIdx];
  const target = targetFraction * totalMass;

  while (accumulated < target && (loIdx > 0 || hiIdx < buckets.length - 1)) {
    const leftCandidate = loIdx > 0 ? buckets[loIdx - 1].liquidity : null;
    const rightCandidate = hiIdx < buckets.length - 1 ? buckets[hiIdx + 1].liquidity : null;
    // Denser (higher-liquidity) neighbor first — the HDR property.
    const takeLeft = leftCandidate != null && (rightCandidate == null || Number(leftCandidate) >= Number(rightCandidate));
    if (takeLeft) {
      loIdx -= 1;
      accumulated += mass[loIdx];
    } else {
      hiIdx += 1;
      accumulated += mass[hiIdx];
    }
  }

  // buckets are tick-ascending; price falls as tick rises (token0=USDC),
  // so the lowest-tick bucket (loIdx) holds the *highest* price bound and
  // vice versa — same inversion documented on LiquidityBucket's fields.
  return {
    lowUsd: buckets[hiIdx].priceLowerUsd,
    highUsd: buckets[loIdx].priceUpperUsd,
    actualFraction: accumulated / totalMass,
  };
}
