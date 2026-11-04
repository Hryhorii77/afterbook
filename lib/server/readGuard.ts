import { NextResponse } from 'next/server';
import { readLimiters } from './ratelimit';

type Bucket = keyof typeof readLimiters;

/** The caller's IP as Vercel passes it (first hop of x-forwarded-for). */
function callerIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Per-IP brake on a public read route that spends chain reads (2026-11-03, from an external review:
 * /api/lots did dozens of RPC reads per call with no limit). Each route counts separately (`name`),
 * in memory (lib/server/ratelimit.ts `readLimiters`). Returns a 429 to send back, or null to proceed.
 */
export function limitRead(request: Request, name: string, bucket: Bucket = 'read', now = Date.now()): NextResponse | null {
  const { success, reset } = readLimiters[bucket].limit(`${name}:${callerIp(request)}`, now);
  if (success) return null;
  const retryAfter = Math.max(1, Math.ceil((reset - now) / 1000));
  return NextResponse.json({ error: 'too many requests, try again shortly' }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
}
