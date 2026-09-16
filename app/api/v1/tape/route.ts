import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { tapeLimiter } from '@/lib/ratelimit';
import { getTape } from '@/lib/tape';
import { toPublicTape } from '@/lib/publicTape';

export const revalidate = 0;

function extractKey(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}

export async function GET(request: NextRequest) {
  if (!redis || !tapeLimiter) {
    return NextResponse.json({ error: 'API unavailable' }, { status: 503 });
  }

  const key = extractKey(request);
  if (!key) {
    return NextResponse.json({ error: 'missing Authorization: Bearer <key> header' }, { status: 401 });
  }

  const record = await redis.get(`apikey:${key}`);
  if (!record) {
    return NextResponse.json({ error: 'invalid API key' }, { status: 401 });
  }

  const { success, reset } = await tapeLimiter.limit(key);
  if (!success) {
    return NextResponse.json(
      { error: 'rate limit exceeded — 1 request/sec' },
      { status: 429, headers: { 'Retry-After': Math.ceil((reset - Date.now()) / 1000).toString() } },
    );
  }

  const tape = await getTape();
  return NextResponse.json(toPublicTape(tape));
}
