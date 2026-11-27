// The numbers behind the rate limits an agent can meet (2026-11-27), apart from lib/server/ratelimit.ts so /AGENTS.md
// (lib/agent/agentsMd.ts) can state them without importing Redis. ratelimit.ts builds its limiters from these, so the
// file and the code can't disagree. Pure: no imports.
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export interface RateLimit {
  /** Requests allowed per window. */
  tokens: number;
  /** The window, for Upstash's sliding window ("1 s", "1 m", "1 d"). */
  window: `${number} ${'s' | 'm' | 'h' | 'd'}`;
  windowMs: number;
}

export const RATE_LIMITS = {
  /** /api/v1/tape, per API key. */
  apiTape: { tokens: 1, window: '1 s', windowMs: SECOND },
  /** POST /api/v1/keys, per IP. */
  apiKeys: { tokens: 5, window: '1 d', windowMs: DAY },
  /** The MCP plan tools, per caller across instances (Upstash). */
  mcpPlan: { tokens: 10, window: '1 m', windowMs: MINUTE },
  /** Plan links saved by the free MCP tools and the Telegram bot, site-wide per day. */
  planLinkDay: { tokens: 300, window: '1 d', windowMs: DAY },
} as const satisfies Record<string, RateLimit>;

/** The in-memory read buckets (limitRead in lib/server/readGuard.ts), per IP and per route, per server instance. */
export const READ_LIMITS = {
  lots: { tokens: 10, windowMs: MINUTE },
  basename: { tokens: 20, windowMs: MINUTE },
  read: { tokens: 60, windowMs: MINUTE },
} as const;
