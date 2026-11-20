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
  /** The deepest stocks a basket may be built from: the 4 it holds and as many again, to replace one
   *  the cost limit drops. The route reads a cost model for each of these (cached pool reads). */
  maxCandidates: 8,
} as const;

/**
 * New listings kept out of every automatic pick and of what leads a page (owner, 2026-11-20): "Describe a basket", the
 * plan's default "deepest pools" (and the x402 plan and basket routes), /build's starting basket, the /rules preselected
 * stock, the headline gap (/today, the home card's and the tape's opening stock, the home card's fallback), live alerts,
 * the share card's rows and the Telegram close digest until
 * their depth has proved itself (owner, 2026-11-20): ANTc was added the day after its IPO, with a 24-hour depth low of
 * ~$42k while liquidity was still arriving. Someone who names the stock can still plan or rule-buy it, under the same
 * caps. Remove an entry once the stock's three-hour depth low holds isLiquid's $1M line (lib/market/liquidity.ts)
 * and its 72-hour "Liquid" label passes, in a PR the owner reviews.
 */
export const AUTO_PICK_HOLD: Record<string, { since: string }> = {
  ANTc: { since: '2026-11-20' },
};
