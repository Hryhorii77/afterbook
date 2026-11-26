// Writes docs/agents/AGENTS.md and docs/agents/llms.txt from lib/agent/agentsMd.ts (the same text /AGENTS.md and /llms.txt
// serve). Run: npm run generate-agents-md. With --check it writes nothing and exits 1 if either file is out of date.
import { register } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

register('./ts-resolve.mjs', import.meta.url);
const { buildAgentsMd, buildLlmsTxt } = await import('../lib/agent/agentsMd.ts');

const root = new URL('../', import.meta.url);
const files: [string, string][] = [
  ['docs/agents/AGENTS.md', buildAgentsMd()],
  ['docs/agents/llms.txt', buildLlmsTxt()],
];
const check = process.argv.includes('--check');
let stale = 0;
for (const [path, text] of files) {
  const url = new URL(path, root);
  let current: string | null = null;
  try {
    current = readFileSync(url, 'utf8');
  } catch {}
  if (current === text) {
    console.log(`${path}: up to date`);
  } else if (check) {
    console.error(`${path}: out of date. Run npm run generate-agents-md and commit the result.`);
    stale++;
  } else {
    writeFileSync(url, text);
    console.log(`${path}: written`);
  }
}
process.exit(stale ? 1 : 0);
