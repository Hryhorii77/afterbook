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
