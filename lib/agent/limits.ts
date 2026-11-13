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
  /** One day under the earnings job's 15-day scan (EARNINGS_SCAN_DAYS): see lib/stocks/earningsCalendar.ts. */
  maxEarningsDays: 14,
  maxNoteChars: 280,
  /** A leg smaller than this is not worth a transaction. */
  minLegUsd: 10,
  /** A gap wider than this either way waits: the pool may be stale, or something happened to the stock. */
  maxAbsGapBp: 300,
} as const;

/** The earnings choices the plan and the basket forms offer. */
export const EARNINGS_OPTIONS = [
  { days: 0, label: 'Ignore earnings' },
  { days: 2, label: 'Wait within 2 days' },
  { days: 7, label: 'Wait within 7 days' },
] as const;

/** "Describe a basket" (lib/agent/brief.ts), here so the page can use them without the server code. */
export const BRIEF_LIMITS = {
  /** The basket buy's cap (MAX_BASKET_USD = MAX_SWAP_USD, $25k); tests/agentBrief.test.ts keeps them equal. */
  maxBudgetUsd: 25_000,
  maxCashPct: 50,
  /** "Spread over at least N stocks": the basket buy takes MIN_LEGS..MAX_LEGS (2..4); tested equal too. */
  minStocks: 2,
  maxStocks: 4,
} as const;
