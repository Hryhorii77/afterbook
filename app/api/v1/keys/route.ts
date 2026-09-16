import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { keyCreationLimiter } from '@/lib/ratelimit';

export const revalidate = 0;

function callerIp(request: NextRequest): string {
  // Vercel sets this; first entry is the original client.
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

export async function POST(request: NextRequest) {
  if (!redis || !keyCreationLimiter) {
    return NextResponse.json({ error: 'key issuance unavailable' }, { status: 503 });
  }

  const { success } = await keyCreationLimiter.limit(callerIp(request));
  if (!success) {
    return NextResponse.json({ error: 'too many keys requested — try again tomorrow' }, { status: 429 });
  }

  const key = `ab_${randomBytes(16).toString('hex')}`;
  await redis.set(`apikey:${key}`, { createdAt: Date.now(), tier: 'free' });

  return NextResponse.json({
    key,
    note: 'Save this now — it will not be shown again. Use it as "Authorization: Bearer <key>" against /api/v1/tape.',
  });
}
