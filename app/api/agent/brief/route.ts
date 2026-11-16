// POST /api/agent/brief: "Describe a basket" on the trade plan (lib/agent/brief.ts) plus Claude's
// explanation (lib/agent/explain.ts). Read-only: it builds nothing a wallet could sign. The basket is
// reviewed and signed in /build's normal basket buy.
import { NextResponse } from 'next/server';
import { limitRead } from '@/lib/server/readGuard';
import { parseBriefInput } from '@/lib/agent/brief';
import { runBrief } from '@/lib/agent/runPlan';

export const maxDuration = 60;

export async function POST(request: Request) {
  // The same 10-a-minute bucket as the plan: a brief is a deliberate click, not a poll.
  const limited = limitRead(request, 'agent-plan', 'lots');
  if (limited) return limited;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const input = parseBriefInput(body);
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });

  try {
    return NextResponse.json(await runBrief(input, request));
  } catch (err) {
    console.error('[/api/agent/brief]', err);
    return NextResponse.json({ error: 'basket unavailable, try again shortly' }, { status: 502 });
  }
}
