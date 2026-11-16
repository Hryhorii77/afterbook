// POST /api/agent/plan: the trade plan (lib/agent/plan.ts) plus Claude's explanation (lib/agent/explain.ts).
// Read-only: it builds nothing a wallet could sign. A buy is reviewed and signed in the swap panel.
import { NextResponse } from 'next/server';
import { getStock } from '@/lib/stocks/tokens';
import { limitRead } from '@/lib/server/readGuard';
import { parsePlanInput } from '@/lib/agent/plan';
import { runPlan } from '@/lib/agent/runPlan';

export const maxDuration = 60;

export async function POST(request: Request) {
  // The 10-a-minute bucket: a plan is a deliberate click, not a poll.
  const limited = limitRead(request, 'agent-plan', 'lots');
  if (limited) return limited;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const input = parsePlanInput(body, (s) => !!getStock(s));
  if (typeof input === 'string') return NextResponse.json({ error: input }, { status: 400 });

  try {
    return NextResponse.json(await runPlan(input, request));
  } catch (err) {
    console.error('[/api/agent/plan]', err);
    return NextResponse.json({ error: 'plan unavailable, try again shortly' }, { status: 502 });
  }
}
