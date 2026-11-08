// The trade plan's input limits, apart from lib/agent/plan.ts so the page can use them without
// pulling the server's pool-reading code into the browser bundle.
export const PLAN_LIMITS = {
  maxSymbols: 8,
  /** "Any" picks this many of the deepest pools. */
  anyCount: 5,
  minBudgetUsd: 10,
  maxBudgetUsd: 100_000,
  maxPremiumBp: 500,
  maxCostBp: 200,
  maxEarningsDays: 14,
  maxNoteChars: 280,
  /** A leg smaller than this is not worth a transaction. */
  minLegUsd: 10,
  /** A gap wider than this either way waits: the pool may be stale, or something happened to the stock. */
  maxAbsGapBp: 300,
} as const;
