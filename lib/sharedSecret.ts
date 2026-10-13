import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';

// Checks a shared secret sent by a caller we trust (Vercel Cron, Telegram).
// Unset secret: open under `next dev` so the routes can be tried, closed in
// every built deployment (production and previews) so a missing env var never
// leaves a cron or the webhook public.
export function secretMatches(expected: string | undefined, given: string | null): boolean {
  if (!expected) return process.env.NODE_ENV !== 'production';
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. */
export function cronAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return secretMatches(secret && `Bearer ${secret}`, request.headers.get('authorization'));
}
