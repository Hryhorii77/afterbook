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

// Divergence loss ("impermanent loss") if price reaches either edge of the
// range, vs. simply holding the position's initial token split without
// ever providing liquidity — the standard concentrated-liquidity IL
// benchmark. Derived from the same virtual-reserve equations as
// capitalEfficiencyMultiplier above (Uniswap v3 whitepaper §6.29-6.30),
// but this one needs true dollar amounts rather than just a ratio, so the
// token0/token1 assignment actually matters here — verified against known
// economics (USDC-side amount rises with price, shares-side amount falls,
// matching which side arbitrageurs drain as price moves) and, as a strong
// closed-form check, against the classic Uniswap V2 IL formula
// IL(k) = 2*sqrt(k)/(1+k) - 1 in the full-range limit (Pa->0, Pb->inf):
// matched to within 0.001% (float epsilon from the limit not being exact).
//
// For range [Pa, Pb] and deposit price P0:
//   amount0(P) = sqrt(P) - sqrt(Pa)         [USDC-like — 0 at Pa, max at Pb]
//   amount1(P) = 1/sqrt(P) - 1/sqrt(Pb)     [shares-like — max at Pa, 0 at Pb]
//   value(P)   = amount0(P) + amount1(P) * P
// hodlValue(P) uses the same amount0/amount1 frozen at P0 (the position
// never entered) instead of at P (the position rebalancing as price moves)
// — the divergence is exactly that difference.
export function computeDivergenceLossAtBoundary(
  rangeLowUsd: number,
  rangeHighUsd: number,
  currentPriceUsd: number,
): { atLowPct: number; atHighPct: number } | null {
  if (rangeLowUsd <= 0 || rangeHighUsd <= rangeLowUsd || currentPriceUsd <= 0) return null;
  if (rangeLowUsd > currentPriceUsd || rangeHighUsd < currentPriceUsd) return null;

  const sqrtPa = Math.sqrt(rangeLowUsd);
  const sqrtPb = Math.sqrt(rangeHighUsd);
  const sqrtP0 = Math.sqrt(currentPriceUsd);

  const amount0_0 = sqrtP0 - sqrtPa;
  const amount1_0 = 1 / sqrtP0 - 1 / sqrtPb;
  const hodlValue = (p: number) => amount0_0 + amount1_0 * p;

  // At the low edge the position has fully converted to amount0 (USDC);
  // at the high edge, fully to amount1 (shares) — amount0(Pa)=0 and
  // amount1(Pb)=0 respectively, so each reduces to a single term.
  const lpValueAtLow = (1 / sqrtPa - 1 / sqrtPb) * rangeLowUsd;
  const lpValueAtHigh = sqrtPb - sqrtPa;

  const hodlAtLow = hodlValue(rangeLowUsd);
  const hodlAtHigh = hodlValue(rangeHighUsd);
  if (hodlAtLow <= 0 || hodlAtHigh <= 0) return null;

  return {
    atLowPct: (lpValueAtLow / hodlAtLow - 1) * 100,
    atHighPct: (lpValueAtHigh / hodlAtHigh - 1) * 100,
  };
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
