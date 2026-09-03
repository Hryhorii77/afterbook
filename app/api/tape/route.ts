import { NextResponse } from 'next/server';
import { getTape } from '@/lib/tape';

export const revalidate = 0; // getTape manages its own short cache

export async function GET() {
  try {
    const tape = await getTape();
    return NextResponse.json(tape);
  } catch (err) {
    return NextResponse.json({ error: 'tape unavailable', detail: String(err) }, { status: 502 });
  }
}
