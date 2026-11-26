// /llms.txt (2026-11-25): the short map of Afterbook for agents, built in lib/agent/agentsMd.ts from the same lists as
// /agents and /AGENTS.md, so they can't disagree. Static text: no Redis, no chain read.
import { buildLlmsTxt } from '@/lib/agent/agentsMd';
import { agentDocResponse } from '@/lib/agent/agentDocsResponse';

export const dynamic = 'force-static';

export function GET() {
  return agentDocResponse(buildLlmsTxt(), 'text/plain');
}
