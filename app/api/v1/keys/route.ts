import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/server/redis';
import { keyCreationLimiter } from '@/lib/server/ratelimit';
import { issueApiKey } from '@/lib/server/apiKeys';

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

  // Only the key's hash is stored, with a one-year expiry (lib/server/apiKeys.ts).
  const { key, expiresAt } = await issueApiKey();

  return NextResponse.json({
    key,
    expiresAt: new Date(expiresAt).toISOString(),
    note: 'Save this now — it will not be shown again (only its hash is stored). Use it as "Authorization: Bearer <key>" against /api/v1/tape. It expires after a year; ask for a new one then.',
  });
}
