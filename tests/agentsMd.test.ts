// /AGENTS.md and /llms.txt (2026-11-26): built from the code, never by hand. Every tracked token and pool, the MCP tools,
// the paid routes and prices, the Builder Code and the safety words must be there, and the committed docs/agents/ copies
// must match what the routes serve.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAgentsMd, buildLlmsTxt, SITE_ROUTES } from '@/lib/agent/agentsMd';
import { FREE_KEY, MCP_URL, PAID, TOOLS } from '@/lib/agent/agentDirectory';
import { AERO_CL_FACTORY, CL_FACTORY, STOCKS, USDC } from '@/lib/stocks/tokens';
import { BUILDER_CODE } from '@/lib/wallet/builderCode';
import { GET as getAgentsMd } from '@/app/AGENTS.md/route';
import { GET as getLlmsTxt } from '@/app/llms.txt/route';

const md = buildAgentsMd();
const txt = buildLlmsTxt();

describe('AGENTS.md', () => {
  it('lists every tracked token and pool, from lib/stocks/tokens.ts', () => {
    expect(STOCKS.length).toBeGreaterThan(0);
    for (const s of STOCKS) {
      const row = md.split('\n').find((l) => l.startsWith(`| ${s.symbol} |`));
      expect(row, s.symbol).toBeDefined();
      expect(row).toContain(s.tokenAddress);
      expect(row).toContain(s.pool.address);
    }
    expect(md).toContain(`## Tracked stocks and pools (${STOCKS.length})`);
  });

  it('names USDC and both CL factories', () => {
    for (const a of [USDC.address, AERO_CL_FACTORY, CL_FACTORY]) expect(md).toContain(a);
  });

  it('lists every MCP tool, paid route and price, the free key and the Builder Code', () => {
    for (const t of TOOLS) expect(md).toContain(`| ${t.name} |`);
    for (const r of PAID) expect(md).toContain(`| ${r.route} | ${r.price} |`);
    expect(md).toContain(MCP_URL);
    expect(md).toContain(FREE_KEY.issue);
    expect(md).toContain(BUILDER_CODE);
    expect(BUILDER_CODE).toBe('bc_hebg61t4');
  });

  it('says the safety rules', () => {
    expect(md).toContain('non-custodial');
    expect(md).toContain('Agents never sign');
    expect(md).toContain('A gap is not risk-free arbitrage');
    expect(md).toContain('not available in the US or its territories');
    expect(md).toContain('new enrollments are paused');
  });

  it('lists only site routes that have a page or route file', () => {
    for (const { path } of SITE_ROUTES) {
      if (path.endsWith('/*')) continue;
      const dir = `app${path === '/' ? '' : path}`;
      const found = ['page.tsx', 'route.ts', 'route.tsx'].some((f) => existsSync(`${dir}/${f}`));
      expect(found, path).toBe(true);
    }
  });
});

describe('llms.txt', () => {
  it('keeps the short index and points at AGENTS.md', () => {
    for (const t of TOOLS) expect(txt).toContain(`- ${t.name}: `);
    for (const r of PAID) expect(txt).toContain(`- ${r.route} (${r.price}): `);
    expect(txt).toContain(FREE_KEY.use);
    expect(txt).toContain('https://afterbook.app/AGENTS.md');
    expect(txt.startsWith('# Afterbook\n')).toBe(true);
  });
});

describe('committed copies and routes', () => {
  it('docs/agents/AGENTS.md and docs/agents/llms.txt match the builders (npm run generate-agents-md)', () => {
    expect(readFileSync('docs/agents/AGENTS.md', 'utf8')).toBe(md);
    expect(readFileSync('docs/agents/llms.txt', 'utf8')).toBe(txt);
  });

  it('keeps no copy in public/, which Next would serve instead of the routes (without their CORS and cache headers)', () => {
    expect(existsSync('public/AGENTS.md')).toBe(false);
    expect(existsSync('public/llms.txt')).toBe(false);
  });

  it('serves them with the right type and open CORS', async () => {
    for (const [res, type, body] of [
      [getAgentsMd(), 'text/markdown; charset=utf-8', md],
      [getLlmsTxt(), 'text/plain; charset=utf-8', txt],
    ] as const) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.text()).toBe(body);
    }
  });
});
