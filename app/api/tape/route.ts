import { NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';

export const revalidate = 0; // getTape manages its own short cache

export async function GET() {
  try {
    const tape = await getTape();
    return NextResponse.json(tape);
  } catch (err) {
    // The cause goes to the server log, not the response (it can name RPC hosts, contract errors).
    console.error('[/api/tape]', err);
    return NextResponse.json({ error: 'tape unavailable' }, { status: 502 });
  }
}
