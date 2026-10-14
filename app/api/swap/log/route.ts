import { NextRequest, NextResponse } from 'next/server';
import { guardSwapRequest } from '@/lib/swapGuard';
import { logSwap } from '@/lib/swapLog';

export const revalidate = 0;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

// The swap panel reports a confirmed swap's hash; lib/swapLog.ts reads it back from the chain and
// records it only if it is an Afterbook swap. POST { hash }
export async function POST(request: NextRequest) {
  const refused = await guardSwapRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as { hash?: unknown } | null;
  if (typeof body?.hash !== 'string' || !HASH_RE.test(body.hash)) return NextResponse.json({ error: 'hash must be a transaction hash' }, { status: 400 });
  try {
    const result = await logSwap(body.hash as `0x${string}`);
    return result.ok ? NextResponse.json({ ok: true, duplicate: result.duplicate }) : NextResponse.json({ error: result.reason }, { status: 422 });
  } catch {
    return NextResponse.json({ error: 'could not read the transaction yet' }, { status: 502 });
  }
}
