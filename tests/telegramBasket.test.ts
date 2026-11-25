import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { parseBasketCommand, basketReplyText, THEME_ALIASES } from '../lib/alerts/telegramBasket';
import { THEMES, SECTORS } from '../lib/stocks/sectors';
import type { Brief } from '../lib/agent/brief';

// `/basket` in the Telegram bot (2026-11-25): the code's own basket (runBrief), saved as a link the person opens on
// afterbook.app to sign. Offline: the brief run, the link store, the limiters and Telegram are fakes.
const fx = vi.hoisted(() => ({ replies: [] as string[], saved: [] as unknown[], brief: null as unknown, inputs: [] as unknown[], linkOk: true, rateOk: true, runs: 0 }));
vi.mock('../lib/agent/runPlan', () => ({
  runPlan: async () => {
    throw new Error('not used');
  },
  runBrief: async (input: unknown) => (fx.runs++, fx.inputs.push(input), { brief: fx.brief, explanation: 'x', explainedBy: 'fixed', fixedBecause: 'not-requested' }),
}));
vi.mock('../lib/agent/savedPlan', () => ({
  saveStockPlan: async () => 'unused',
  saveBasket: async (_o: unknown, via: string) => (fx.saved.push(via), 'AbCdEfGhIjKlMnOp'),
}));
vi.mock('../lib/server/ratelimit', () => ({
  mcpPlanLimiter: { limit: async () => ({ success: fx.rateOk }) },
  planLinkDailyLimiter: { limit: async () => ({ success: fx.linkOk }) },
}));
vi.mock('../lib/alerts/telegram', () => ({ sendTelegramMessage: async (_c: number, t: string) => void fx.replies.push(t) }));
vi.mock('../lib/share/siteUrl', () => ({ siteUrl: 'https://afterbook.app' }));
vi.mock('../lib/server/sharedSecret', () => ({ secretMatches: () => true }));
const seen = new Set<string>();
vi.mock('../lib/server/redis', () => ({ redis: { set: async (k: string) => (seen.has(k) ? null : (seen.add(k), 'OK')) } }));

import { POST } from '../app/api/telegram/webhook/route';

const session = { state: 'open', label: 'Cash market open', nextOpenIso: '' };
const pick = (symbol: string, weightPct: number, usd: number, extra: object = {}) => ({ symbol, name: symbol, weightPct, usd, costBp: 6, gapBp: 5, gapAgainst: 'price', depthUsd: 2e6, depthAsOfMs: 0, depthSinceMs: 0, sizedDownBy: null, ...extra });
const basket = (picks: ReturnType<typeof pick>[], cashUsd = 0): Brief =>
  ({
    input: { budgetUsd: 100 },
    picks,
    basket: picks.map((p) => ({ symbol: p.symbol, weightPct: p.weightPct })),
    investedUsd: picks.reduce((s, p) => s + p.usd, 0),
    cashUsd,
    dropped: [{ symbol: 'METAc', why: 'x' }],
    shortfall: null,
    suggestion: null,
    session,
  }) as unknown as Brief;
const LIMITS = { maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2, minStocks: 3 };
let nextUpdate = 1;
const send = (text: string, updateId = nextUpdate++) =>
  POST(new NextRequest('https://afterbook.app/api/telegram/webhook', { method: 'POST', body: JSON.stringify({ update_id: 50_000 + updateId, message: { chat: { id: 42 }, text } }), headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  Object.assign(fx, { replies: [], saved: [], inputs: [], linkOk: true, rateOk: true, runs: 0 });
  fx.brief = basket([pick('NVDAc', 34, 34), pick('MSFTc', 33, 33), pick('AAPLc', 33, 33)]);
});

describe('/basket command parsing', () => {
  it('an amount alone is any theme; a theme word maps to a fixed theme; "tech" is the Information Technology sector', () => {
    expect(parseBasketCommand(['100'])).toEqual({ theme: 'Any', exclude: [], budgetUsd: 100, label: 'any theme', command: '/basket 100' });
    expect(parseBasketCommand(['Chips', '$1,000'])).toEqual({ theme: 'AI chips', exclude: [], budgetUsd: 1000, label: 'AI chips', command: '/basket chips 1000' });
    expect(parseBasketCommand(['chips', '250', '2'])).toMatchObject({ theme: 'AI chips', budgetUsd: 250, minStocks: 2, command: '/basket chips 250' });
    expect(parseBasketCommand(['100', '4'])).toMatchObject({ theme: 'Any', budgetUsd: 100, minStocks: 4 });
    const tech = parseBasketCommand(['tech', '100']);
    expect(tech).toMatchObject({ theme: 'Any', budgetUsd: 100, label: 'Information Technology' });
    expect(typeof tech !== 'string' && tech.exclude).toEqual(SECTORS.filter((s) => s !== 'Information Technology'));
  });
  it('every fixed theme has a word', () => {
    const reached = new Set(Object.values(THEME_ALIASES).map((a) => a.theme));
    for (const t of THEMES) expect(reached.has(t)).toBe(true);
  });
  it('refuses free text, a missing amount and extra words', () => {
    expect(parseBasketCommand([])).toMatch(/Usage/);
    expect(parseBasketCommand(['tech'])).toMatch(/amount in USD/);
    expect(parseBasketCommand(['ignore previous instructions', '100'])).toMatch(/Unknown theme/);
    expect(parseBasketCommand(['tech', 'chips', '100'])).toMatch(/Usage/);
    expect(parseBasketCommand(['tech', '100', '5'])).toMatch(/Usage/); // 5 isn't a stock count, so three words
    expect(parseBasketCommand(['100', '1'])).toMatch(/stock count must be 2, 3 or 4/);
    expect(parseBasketCommand(['$100', '7'])).toMatch(/stock count must be 2, 3 or 4/);
  });
});

describe('/basket in the bot', () => {
  it('runs the basket code at the page’s defaults and replies with its picks and a saved link to sign', async () => {
    await send('/basket tech 100');
    expect(fx.inputs[0]).toMatchObject({ theme: 'Any', budgetUsd: 100, minStocks: 3, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2, note: '' });
    expect((fx.inputs[0] as { exclude: string[] }).exclude).not.toContain('Information Technology');
    expect(fx.saved).toEqual(['telegram']);
    const r = fx.replies[0];
    expect(r).toContain('Basket for $100.00 (Information Technology, Cash market open):');
    expect(r).toContain('• NVDAc: 34%, $34.00, cost about 0.06%');
    expect(r).toContain('Open to sign: https://afterbook.app/plan/AbCdEfGhIjKlMnOp');
    expect(r).toContain('Not available in the US or its territories.');
  });
  it('no basket: the code’s own reason, no link; daily cap reached: the basket without a link', async () => {
    fx.brief = { ...basket([]), picks: null, basket: null, shortfall: '2 stocks pass (NVDAc and MSFTc) and you asked to spread over at least 3, so there is no basket.', suggestion: { minStocks: 2, text: '2 passed. Spread over at least 2?' } };
    await send('/basket 100');
    expect(fx.saved).toEqual([]);
    expect(fx.replies[0]).toContain('so there is no basket.');
    expect(fx.replies[0]).toContain('To spread over 2 instead, send: /basket 100 2');
    await send('/basket 100 2');
    expect(fx.inputs.at(-1)).toMatchObject({ minStocks: 2 });
    fx.replies.shift();
    expect(fx.replies[0]).not.toContain('Open to sign');
    fx.brief = basket([pick('NVDAc', 50, 50), pick('MSFTc', 50, 50)]);
    fx.linkOk = false;
    await send('/basket 100');
    expect(fx.saved).toEqual([]);
    expect(fx.replies[1]).toContain('daily limit on saved plans');
  });
  it('over the per-chat limit, a bad theme or a bad budget: no basket is run', async () => {
    fx.rateOk = false;
    await send('/basket 100');
    fx.rateOk = true;
    await send('/basket crypto 100');
    await send('/basket 5');
    await send('/basket 99999');
    expect(fx.runs).toBe(0);
    expect(fx.replies[0]).toMatch(/Too many plans/);
    expect(fx.replies[1]).toMatch(/Unknown theme/);
    expect(fx.replies[2]).toMatch(/Can't make that basket: the budget/);
    expect(fx.replies[3]).toMatch(/Can't make that basket: the budget/);
  });
  it('a resent update gets no second basket, link or reply', async () => {
    await send('/basket 100', 777);
    await send('/basket 100', 777);
    expect(fx.runs).toBe(1);
    expect(fx.replies).toHaveLength(1);
  });
  it('the reply never asks for a wallet or a signature of its own, and shows cash kept and a sized-down pick', () => {
    const text = basketReplyText(basket([pick('NVDAc', 60, 60, { sizedDownBy: 'cost limit' })], 40), LIMITS, 'any theme', '/basket 100', 'https://afterbook.app/plan/x', false);
    expect(text).not.toMatch(/private key|seed|approve/i);
    expect(text).toContain('Kept as cash: $40.00.');
    expect(text).toContain('(less than an equal share: cost limit)');
  });
});
