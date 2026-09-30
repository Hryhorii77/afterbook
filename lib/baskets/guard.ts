import { NextRequest, NextResponse } from 'next/server';
import { getGeoInfo } from '../geo';
import { gliderConfigured, GliderError } from '../glider';
import { basketLimiter } from '../ratelimit';

export const OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
// Anything on Base, since positions can include USDC and other ERC-20s.
export const BASE_ASSET_RE = /^eip155:8453\/erc20:0x[0-9a-fA-F]{40}$/;
export const RAW_AMOUNT_RE = /^[0-9]{1,78}$/;

export const ownerAccountId = (address: string) => `eip155:0:${address}`;

export function strategyId(): string | null {
  // Trimmed: a pasted-in env value with stray whitespace otherwise reaches Glider as a different id.
  return process.env.GLIDER_STRATEGY_ID?.trim() || null;
}

function callerIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** Shared front door for every /api/baskets/* route: same fail-closed,
 *  best-effort non-US gate as the page (unknown country is refused, same as
 *  a US IP), then config, then rate limit. Returns a response to send back,
 *  or null to proceed. A missing limiter (no Redis) refuses rather than
 *  allows, since these routes spend a shared API key. */
export async function guardBasketRequest(request: NextRequest): Promise<NextResponse | null> {
  const geo = await getGeoInfo();
  if (!geo.nonUs) return NextResponse.json({ error: 'not available in your region' }, { status: 403 });
  if (!gliderConfigured() || !strategyId()) return NextResponse.json({ error: 'baskets are not enabled yet' }, { status: 503 });
  if (!basketLimiter) return NextResponse.json({ error: 'rate limiter unavailable' }, { status: 503 });
  const { success } = await basketLimiter.limit(callerIp(request));
  if (!success) return NextResponse.json({ error: 'too many requests' }, { status: 429 });
  return null;
}

export async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Glider errors are safe to surface (code + message describe the request,
 *  never the key), but only 4xx are the caller's fault; anything else is ours. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof GliderError) {
    const status = err.status >= 400 && err.status < 500 ? err.status : 502;
    return NextResponse.json({ error: err.message, code: err.code, details: err.details }, { status });
  }
  return NextResponse.json({ error: 'unexpected error' }, { status: 500 });
}
