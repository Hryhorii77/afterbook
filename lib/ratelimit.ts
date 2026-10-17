import { Ratelimit, type Duration } from '@upstash/ratelimit';
import { redis } from './redis';

/** What callers read from `.limit()`: the Upstash result's shape, trimmed to what they use. */
interface LimitResult {
  success: boolean;
  reset: number;
}

/** An Upstash limiter that keeps working when Redis doesn't. On 2026-10-18 the Upstash plan hit its
 *  monthly request cap and every `.limit()` threw, which took swaps, Baskets and Share down with a
 *  500. Now a Redis error falls back to a per-instance count with the same rate: looser (each
 *  serverless instance counts on its own), but the routes stay up. */
class SafeLimiter {
  private readonly upstash: Ratelimit;
  private readonly local = new Map<string, { start: number; count: number }>();
  constructor(
    prefix: string,
    private readonly tokens: number,
    window: Duration,
    private readonly windowMs: number,
    /** Tokens per window for the in-memory count. Lower than `tokens` where the limit guards a shared
     *  outside budget (KyberSwap, Glider): every warm instance counts on its own. */
    private readonly fallbackTokens = tokens,
  ) {
    this.upstash = new Ratelimit({ redis: redis!, limiter: Ratelimit.slidingWindow(tokens, window), prefix });
  }
  async limit(key: string): Promise<LimitResult> {
    try {
      const { success, reset } = await this.upstash.limit(key);
      return { success, reset };
    } catch (err) {
      console.error('rate limiter: Redis unavailable, counting in memory', err instanceof Error ? err.message : err);
      return this.limitLocally(key);
    }
  }
  private limitLocally(key: string): LimitResult {
    const now = Date.now();
    const w = this.local.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (this.local.size > 10_000) {
        for (const [k, v] of this.local) if (now - v.start >= this.windowMs) this.local.delete(k);
      }
      this.local.set(key, { start: now, count: 1 });
      return { success: true, reset: now + this.windowMs };
    }
    w.count += 1;
    return { success: w.count <= this.fallbackTokens, reset: w.start + this.windowMs };
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Null when Redis isn't configured — same posture as everywhere else in
// this app, but callers here should treat a null limiter as "can't verify,
// refuse" rather than "allow," since the whole point of a key system is the
// check actually happening.
export const tapeLimiter = redis ? new SafeLimiter('ratelimit:tape', 1, '1 s', SECOND) : null;

// Abuse guard on key creation itself, not a hard security boundary — this
// is a free, frictionless self-serve flow by design.
export const keyCreationLimiter = redis ? new SafeLimiter('ratelimit:keys', 5, '1 d', 24 * 60 * MINUTE) : null;

// Outbound-click logging (lib/clicks.ts) is analytics, not a security
// boundary, but it's still a public unauthenticated write — this just
// keeps one browser tab from being able to flood the log, not a real
// abuse defense.
export const clickLimiter = redis ? new SafeLimiter('ratelimit:clicks', 30, '1 m', MINUTE) : null;

// Every /api/baskets/* call spends the shared Glider tenant key, whose own
// rate limits are per IP (ours, since calls come from Vercel) — so this keeps
// one visitor from burning the budget for everyone else.
export const basketLimiter = redis ? new SafeLimiter('ratelimit:baskets', 20, '1 m', MINUTE, 10) : null;

// Share snapshots (lib/shareSnapshot.ts) are a public write that stores ~5 KB per share for 30
// days: generous for a person sharing, tight enough that one client can't fill the store.
export const shareLimiter = redis ? new SafeLimiter('ratelimit:share', 20, '10 m', 10 * MINUTE) : null;

// /api/swap/* calls KyberSwap's public API (3 requests/s shared by every visitor, from our server's IP),
// so one visitor's open swap panel (a quote every 15 s plus builds) must not use it up for everyone.
export const swapLimiter = redis ? new SafeLimiter('ratelimit:swap', 30, '1 m', MINUTE, 15) : null;
