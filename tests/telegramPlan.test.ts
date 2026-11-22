import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { parsePlanCommand, planReplyText } from '../lib/alerts/telegramPlan';
import type { Plan } from '../lib/agent/plan';

// `/plan` in the Telegram bot (2026-11-22): the code's own plan, saved as a link the person opens on afterbook.app
// to sign. Offline: the plan run, the link store, the limiters and Telegram are fakes.
const fx = vi.hoisted(() => ({ replies: [] as string[], saved: [] as unknown[], plan: null as unknown, linkOk: true, rateOk: true, runs: 0 }));
vi.mock('../lib/agent/runPlan', () => ({ runPlan: async () => (fx.runs++, { plan: fx.plan, explanation: 'x', explainedBy: 'fixed', fixedBecause: 'not-requested' }) }));
vi.mock('../lib/agent/savedPlan', () => ({ saveStockPlan: async (_i: unknown, _o: unknown, via: string) => (fx.saved.push(via), 'AbCdEfGhIjKlMnOp') }));
vi.mock('../lib/server/ratelimit', () => ({
  mcpPlanLimiter: { limit: async () => ({ success: fx.rateOk }) },
  planLinkDailyLimiter: { limit: async () => ({ success: fx.linkOk }) },
}));
vi.mock('../lib/alerts/telegram', () => ({ sendTelegramMessage: async (_c: number, t: string) => void fx.replies.push(t) }));
vi.mock('../lib/share/siteUrl', () => ({ siteUrl: 'https://afterbook.app' }));
vi.mock('../lib/server/sharedSecret', () => ({ secretMatches: () => true }));
const seen = new Set<string>();
vi.mock('../lib/server/redis', () => ({ redis: { set: async (k: string) => (seen.has(k) ? null : (seen.add(k), 'OK')) } }));
const LIMITS = { maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2 };

import { POST } from '../app/api/telegram/webhook/route';

const leg = (symbol: string, verdict: 'buy' | 'wait' | 'skip', extra: object = {}) => ({ symbol, name: symbol, verdict, reasons: ['Earnings in 1 day.'], gapBp: 10, gapAgainst: 'close', priceUsd: 100, depthUsd: 1e6, ...extra });
const plan = (legs: unknown[]): Plan => ({ legs, budgetUsd: 100, plannedUsd: 60, session: { state: 'closed-weekend', label: 'Weekend', nextOpenIso: '' }, createdAt: 0 }) as Plan;
let nextUpdate = 1;
const send = (text: string, updateId = nextUpdate++) =>
  POST(new NextRequest('https://afterbook.app/api/telegram/webhook', { method: 'POST', body: JSON.stringify({ update_id: updateId, message: { chat: { id: 42 }, text } }), headers: { 'content-type': 'application/json' } }));

beforeEach(() => {
  fx.replies = [];
  fx.saved = [];
  fx.linkOk = true;
  fx.rateOk = true;
  fx.runs = 0;
  fx.plan = plan([leg('NVDAc', 'buy', { usd: 60, costBp: 12 }), leg('AAPLc', 'wait', { decidedBy: 'Earnings in 1 day.' })]);
});

describe('/plan command parsing', () => {
  const find = (s: string) => ({ NVDA: 'NVDAc', NVDAC: 'NVDAc', AAPL: 'AAPLc' })[s.toUpperCase()];
  it('takes stocks then a USD amount', () => {
    expect(parsePlanCommand(['NVDA', '100'], find)).toEqual({ symbols: ['NVDAc'], budgetUsd: 100 });
    expect(parsePlanCommand(['nvda', 'NVDAc', 'AAPL', '$1,250'], find)).toEqual({ symbols: ['NVDAc', 'AAPLc'], budgetUsd: 1250 });
  });
  it('refuses a missing amount, an unknown stock, junk and too many stocks', () => {
    expect(parsePlanCommand(['NVDA'], find)).toMatch(/Usage/);
    expect(parsePlanCommand(['NVDA', 'lots'], find)).toMatch(/amount in USD/);
    expect(parsePlanCommand(['NVDA', '1e9'], find)).toMatch(/amount in USD/);
    expect(parsePlanCommand(['TSLAQ', '100'], find)).toMatch(/Unknown stock/);
    expect(parsePlanCommand(['NVDA', 'NVDA', 'NVDA', 'NVDA', 'AAPL', '100'], find)).toMatch(/Up to 4/);
  });
});

describe('/plan in the bot', () => {
  it('replies with the code’s verdicts and a saved link to sign on afterbook.app', async () => {
    await send('/plan NVDA AAPL 100');
    expect(fx.saved).toEqual(['telegram']);
    expect(fx.replies[0]).toContain('• NVDAc: buy $60.00, cost about 0.12%');
    expect(fx.replies[0]).toContain('• AAPLc: wait. Earnings in 1 day.');
    expect(fx.replies[0]).toContain('Open to sign: https://afterbook.app/plan/AbCdEfGhIjKlMnOp');
  });
  it('no buy: no link saved; daily cap reached: the plan without a link', async () => {
    fx.plan = plan([leg('NVDAc', 'skip', { decidedBy: 'The pool is stale.' })]);
    await send('/plan NVDA 100');
    expect(fx.saved).toEqual([]);
    expect(fx.replies[0]).toContain('Nothing a link can offer now, so no link.');
    fx.plan = plan([leg('NVDAc', 'buy', { usd: 60 })]);
    fx.linkOk = false;
    await send('/plan NVDA 100');
    expect(fx.saved).toEqual([]);
    expect(fx.replies[1]).toContain('daily limit on saved plans');
  });
  it('over the per-chat limit or with a bad budget: no plan is run', async () => {
    fx.rateOk = false;
    await send('/plan NVDA 100');
    await send('/plan NVDA 0');
    fx.rateOk = true;
    await send('/plan NVDA 99999999');
    expect(fx.runs).toBe(0);
    expect(fx.replies[0]).toMatch(/Too many plans/);
    expect(fx.replies[1]).toMatch(/Can't plan that: the budget/);
    expect(fx.replies[2]).toMatch(/Can't plan that: the budget/);
  });
  it('the reply never holds a wallet request or a signing step of its own', () => {
    const text = planReplyText(fx.plan as Plan, LIMITS, 'https://afterbook.app/plan/x', false);
    expect(text).not.toMatch(/private key|seed|approve/i);
  });
  it('a resent update (same update_id) gets no second plan, link or reply', async () => {
    await send('/plan NVDA 100', 9001);
    await send('/plan NVDA 100', 9001);
    expect(fx.runs).toBe(1);
    expect(fx.saved).toHaveLength(1);
    expect(fx.replies).toHaveLength(1);
  });
  it('a new listing’s buy says the link won’t offer it, and the limits line comes from the plan’s own limits', () => {
    const text = planReplyText(plan([leg('ANTc', 'buy', { usd: 100 })]), { maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2 }, null, false);
    expect(text).toContain('ANTc: buy $100.00 (new listing: not offered from a link');
    expect(text).toContain('Nothing a link can offer now');
    expect(text).toContain('at most 0.50% over the real stock, 0.30% to trade, and wait within 2 days');
  });
});
