// /AGENTS.md (2026-11-26): the "read me first" for agents, like base.org/AGENTS.md. Built in lib/agent/agentsMd.ts from
// the code (every token and pool from lib/stocks/tokens.ts); docs/agents/AGENTS.md is the same text, checked by a test. Keep
// the copies out of public/: a file there would be served instead of this route.
import { buildAgentsMd } from '@/lib/agent/agentsMd';
import { agentDocResponse } from '@/lib/agent/agentDocsResponse';

export const dynamic = 'force-static';

export function GET() {
  return agentDocResponse(buildAgentsMd(), 'text/markdown');
}
