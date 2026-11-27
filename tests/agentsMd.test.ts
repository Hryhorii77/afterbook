// /AGENTS.md and /llms.txt (2026-11-26): built from the code, never by hand. Every tracked token and pool, the MCP tools,
// the paid routes and prices, the Builder Code and the safety words must be there, and the committed docs/agents/ copies
// must match what the routes serve.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAgentsMd, buildLlmsTxt, SITE_ROUTES } from '@/lib/agent/agentsMd';
import { FREE_KEY, MCP_URL, PAID, TOOLS } from '@/lib/agent/agentDirectory';
import { AERO_CL_FACTORY, CL_FACTORY, STOCKS, USDC } from '@/lib/stocks/tokens';
import { BUILDER_CODE } from '@/lib/wallet/builderCode';
import { KYBER_ROUTER, MAX_BUY_DEPTH_SHARE, MAX_SWAP_USD } from '@/lib/swap/swap';
import { AAVE_MAG7_SPOKE } from '@/lib/lending/aaveBorrow';
import { PLAN_DEFAULTS, PLAN_LIMITS } from '@/lib/agent/limits';
import { RATE_LIMITS, READ_LIMITS } from '@/lib/server/rateLimits';
import { MCP_EXAMPLES, MCP_INPUTS } from '@/lib/agent/mcpTools';
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
      // The factory's name and address, so an agent can tell which exchange made the pool.
      expect(row).toContain(s.pool.factory);
      expect(row).toMatch(s.pool.factory === AERO_CL_FACTORY ? /\| Aero, 0x/ : /\| Aerodrome \(older factory\), 0x/);
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

  it('names the only approval spenders, with Basescan links', () => {
    for (const a of [KYBER_ROUTER, AAVE_MAG7_SPOKE, USDC.address, AERO_CL_FACTORY, CL_FACTORY]) {
      expect(md).toContain(`[${a}](https://basescan.org/address/${a})`);
    }
  });

  it("defines the cost limit and the size cap with the code's numbers", () => {
    expect(md).toContain('Cost limit (maxCostBp)');
    expect(md).toContain(`Default ${PLAN_DEFAULTS.maxCostBp} bp`);
    expect(md).toContain(`at most ${PLAN_LIMITS.maxCostBp} bp`);
    const cap = `the lower of $${MAX_SWAP_USD.toLocaleString('en-US')} and ${Math.round(MAX_BUY_DEPTH_SHARE * 100)}% of its pool's live depth`;
    expect(md).toContain(`Size cap: every buy, whatever the budget, is capped at ${cap}.`);
    expect(md).toContain(`A stock buy is capped at ${cap}.`);
  });

  it("shows every MCP tool's inputs from its schema, with an example the schema accepts", () => {
    expect(Object.keys(MCP_INPUTS).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of TOOLS) {
      const name = t.name as keyof typeof MCP_INPUTS;
      const section = md.split(`#### ${name}\n`)[1]?.split('\n#### ')[0].split('\n### ')[0];
      expect(section, name).toBeDefined();
      for (const key of Object.keys(MCP_INPUTS[name].shape)) expect(section, `${name}.${key}`).toContain(`- \`${key}\` (`);
      expect(MCP_INPUTS[name].safeParse(MCP_EXAMPLES[name]).success, `${name} example`).toBe(true);
      expect(section).toContain(`Example: \`${JSON.stringify({ name, arguments: MCP_EXAMPLES[name] })}\``);
    }
  });

  it('states the rate limits from the limiters and what a caller gets when one is hit', () => {
    const table = md.split('### Rate limits\n')[1]?.split('\n## ')[0] ?? '';
    expect(table).toContain(`| MCP make_plan, make_basket | ${RATE_LIMITS.mcpPlan.tokens} a minute per caller`);
    expect(table).toContain(`at most ${RATE_LIMITS.planLinkDay.tokens} saved plan links a day`);
    expect(table).toContain(`| GET /api/v1/tape | ${RATE_LIMITS.apiTape.tokens} a second per key`);
    expect(table).toContain(`| POST /api/v1/keys | ${RATE_LIMITS.apiKeys.tokens} a day per IP`);
    expect(table).toContain(`| MCP check_loan_health, make_rescue_link | ${READ_LIMITS.lots.tokens} a minute per IP`);
    expect(table).toContain(`${READ_LIMITS.read.tokens} a minute per IP for most`);
    expect(table).toContain(`${READ_LIMITS.basename.tokens} a minute for /api/basename`);
    expect(table).toContain('HTTP 429');
    expect(table).toContain('Retry-After');
    expect(table).toContain('a 429 is not charged');
  });

  it('says the safety rules', () => {
    expect(md).toContain('non-custodial');
    expect(md).toContain('Agents never sign');
    expect(md).toContain('A gap is not risk-free arbitrage');
    expect(md).toContain('not available in the US or its territories');
    expect(md).toContain('new enrollments are paused');
    // The fee is an env setting; text fixed at build time must not claim its state.
    expect(md).not.toMatch(/fee is (off|on)|are not set|they are not/i);
    expect(md).toContain('Read any fee from the live quote');
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
