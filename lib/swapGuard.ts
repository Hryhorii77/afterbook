import { NextRequest, NextResponse } from 'next/server';
import { getGeoInfo } from './geo';
import { swapLimiter } from './ratelimit';

function callerIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

/** Front door for every /api/swap/* route, same posture as guardBasketRequest: the best-effort non-US
 *  gate fails closed (unknown country is refused, same as a US IP), and a missing rate limiter (no
 *  Redis) refuses rather than allows. Returns a response to send back, or null to proceed. */
export async function guardSwapRequest(request: NextRequest): Promise<NextResponse | null> {
  const geo = await getGeoInfo();
  if (!geo.nonUs) return NextResponse.json({ error: 'not available in your region' }, { status: 403 });
  if (!swapLimiter) return NextResponse.json({ error: 'rate limiter unavailable' }, { status: 503 });
  const { success } = await swapLimiter.limit(callerIp(request));
  if (!success) return NextResponse.json({ error: 'too many requests, try again in a minute' }, { status: 429 });
  return null;
}
