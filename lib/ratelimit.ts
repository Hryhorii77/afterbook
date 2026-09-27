import { Ratelimit } from '@upstash/ratelimit';
import { redis } from './redis';

// Null when Redis isn't configured — same posture as everywhere else in
// this app, but callers here should treat a null limiter as "can't verify,
// refuse" rather than "allow," since the whole point of a key system is the
// check actually happening.
export const tapeLimiter = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(1, '1 s'), prefix: 'ratelimit:tape' })
  : null;

// Abuse guard on key creation itself, not a hard security boundary — this
// is a free, frictionless self-serve flow by design.
export const keyCreationLimiter = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(5, '1 d'), prefix: 'ratelimit:keys' })
  : null;

// Outbound-click logging (lib/clicks.ts) is analytics, not a security
// boundary, but it's still a public unauthenticated write — this just
// keeps one browser tab from being able to flood the log, not a real
// abuse defense.
export const clickLimiter = redis
  ? new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, '1 m'), prefix: 'ratelimit:clicks' })
  : null;
