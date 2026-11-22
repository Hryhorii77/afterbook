import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { AlertRule } from '../lib/alerts/alerts';
import type { WalletLoan } from '../lib/lending/loanHealth';
import { rotate, stateAfterSend } from '../lib/alerts/alerts';
import { LOAN_READ_FAIL_NOTICE } from '../lib/lending/loanHealth';

// The 5-minute alerts cron, offline: the tape, the samples, the rule store, Telegram, the loan reads and
// the run lock are fakes. What it checks: an alert Telegram didn't accept is tried again (not lost), two
// runs at once send once, and a wallet that can't be read for 30 minutes gets one heads-up.
const fx = vi.hoisted(() => ({
  rules: new Map<string, unknown[]>(),
  sent: [] as string[],
  deliver: true as boolean | 'refused',
  loans: null as unknown,
  lockHeld: false,
  unreadable: [] as string[],
  duringSend: null as null | ((chat: string) => void),
  rereadFails: false,
  breakClose: null as string | null,
}));
vi.mock('../lib/market/tape', () => ({
  getTape: async () => ({ rows: [], fetchedAt: 0, session: { state: 'open', label: 'Open', nyTime: '10:00', dateKey: '2026-11-21', nextOpenIso: '' } }),
  recordTapeSamples: async () => {},
}));
vi.mock('../lib/market/marketClock', async (orig) => ({
  ...(await orig<typeof import('../lib/market/marketClock')>()),
  longBreakClose: () => fx.breakClose,
  nextOpenWeekday: () => 'Monday',
}));
vi.mock('../lib/market/depthSamples', () => ({ recordDepthSample: async () => {} }));
vi.mock('../lib/alerts/alerts', async (orig) => ({
  ...(await orig<typeof import('../lib/alerts/alerts')>()),
  getAllChatIds: async () => [...fx.rules.keys()],
  getRulesOrNull: async (id: string) => (fx.rereadFails ? null : fx.rules.get(id) ?? []),
  getRulesMany: async (ids: string[]) => new Map(ids.filter((id) => !fx.unreadable.includes(id)).map((id) => [id, fx.rules.get(id) ?? []])),
  setRules: async (id: string, r: unknown[]) => void fx.rules.set(id, r),
}));
vi.mock('../lib/alerts/telegram', () => ({
  sendTelegramMessageStatus: async (c: string, text: string) => {
    fx.duringSend?.(c);
    return fx.deliver === 'refused' ? 'refused' : fx.deliver ? (fx.sent.push(text), 'sent') : 'retry';
  },
}));
vi.mock('../lib/lending/loanPositions', () => ({
  getWalletLoans: async () => {
    if (fx.loans == null) throw new Error('oracle down');
    return fx.loans;
  },
}));
vi.mock('../lib/server/redis', () => ({
  redis: {
    set: async () => (fx.lockHeld ? null : 'OK'),
    eval: async () => 1,
  },
}));
vi.mock('../lib/share/siteUrl', () => ({ siteUrl: 'https://afterbook.app' }));

import { GET } from '../app/api/cron/alerts/route';

process.env.CRON_SECRET = 'test-secret';
const run = async () => (await GET(new NextRequest('https://afterbook.app/api/cron/alerts', { headers: { authorization: 'Bearer test-secret' } }))).json();
const WALLET = '0x1234567890123456789012345678901234567890';
const rule = (): AlertRule => ({ id: 'r1', type: 'loan', wallet: WALLET, thresholdHf: 1.2, active: false });
const lowLoan: WalletLoan = {
  venue: 'aave',
  collateral: [{ symbol: 'NVDAc', amount: 1, oraclePriceUsd: 100, aeroPriceUsd: 100, collateralFactor: 0.7 }],
  debtUsd: 63,
  healthFactor: 1.11,
};
const stored = () => fx.rules.get('chat1')![0] as AlertRule;

beforeEach(() => {
  fx.rules = new Map([['chat1', [rule()]]]);
  fx.sent = [];
  fx.deliver = true;
  fx.loans = [lowLoan];
  fx.lockHeld = false;
  fx.unreadable = [];
  fx.duringSend = null;
  fx.rereadFails = false;
  fx.breakClose = null;
});

describe('alerts cron', () => {
  it('keeps the old state when a message wasn’t delivered', () => {
    expect(stateAfterSend(false, true, 'x', false)).toBe(false);
    expect(stateAfterSend(false, true, 'x', true)).toBe(true);
    expect(stateAfterSend(true, false, null, false)).toBe(false);
  });

  it('a loan warning Telegram didn’t accept is sent on the next run, once', async () => {
    fx.deliver = false;
    expect(await run()).toMatchObject({ ok: true, sent: 0 });
    expect(stored().active).toBe(false);
    fx.deliver = true;
    expect(await run()).toMatchObject({ sent: 1 });
    expect(fx.sent[0]).toContain('Repay USDC: https://afterbook.app/borrow?rescue=repay');
    expect(stored().active).toBe(true);
    expect(await run()).toMatchObject({ sent: 0 });
  });

  it('a chat that blocked the bot isn’t retried every tick', async () => {
    fx.deliver = 'refused';
    await run();
    expect(stored().active).toBe(true);
  });

  it('checks every chat, several at a time, and reports chats it couldn’t read', async () => {
    for (let i = 2; i <= 20; i++) fx.rules.set(`chat${i}`, [{ ...rule(), id: `r${i}` }]);
    fx.unreadable = ['chat7'];
    const out = await run();
    expect(out).toMatchObject({ chats: 20, checked: 19, unread: 1, skipped: 0, sent: 19 });
    expect((fx.rules.get('chat7')![0] as AlertRule).active).toBe(false);
  });

  it('doesn’t undo a /stop or a new rule the person sent while the run was going', async () => {
    fx.duringSend = (c) => fx.rules.set(c, []);
    await run();
    expect(fx.rules.get('chat1')).toEqual([]);
    fx.rules.set('chat1', [rule()]);
    fx.duringSend = (c) => fx.rules.set(c, [...(fx.rules.get(c) as AlertRule[]), { id: 'new', type: 'close', active: false }]);
    await run();
    expect((fx.rules.get('chat1') as AlertRule[]).map((r) => [r.id, r.active])).toEqual([['r1', true], ['new', false]]);
  });

  it('saves the run’s state even if the re-read before the write fails, so an alert isn’t sent twice', async () => {
    fx.rereadFails = true;
    await run();
    expect(stored().active).toBe(true);
    await run();
    expect(fx.sent).toHaveLength(1);
  });

  it('rotates the order by tick, so a budget-cut run doesn’t always miss the same chats', () => {
    expect(rotate(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
    expect(rotate([], 3)).toEqual([]);
  });

  it('a run that finds another one sending skips, and sends nothing', async () => {
    fx.lockHeld = true;
    expect(await run()).toMatchObject({ ok: true, skipped: 'another run is sending' });
    expect(fx.sent).toEqual([]);
    expect(stored().active).toBe(false);
  });

  it('after 30 minutes of failed reads: one heads-up, kept state, and a reset on the next good read', async () => {
    fx.loans = null;
    for (let i = 1; i < LOAN_READ_FAIL_NOTICE; i++) await run();
    expect(fx.sent).toEqual([]);
    expect(stored().failedReads).toBe(LOAN_READ_FAIL_NOTICE - 1);
    // The heads-up isn't delivered the first time: it is tried again next tick.
    fx.deliver = false;
    await run();
    fx.deliver = true;
    await run();
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]).toContain('loan warnings are paused');
    // Still failing: no second heads-up, and the rules aren't rewritten on every tick.
    await run();
    await run();
    expect(fx.sent).toHaveLength(1);
    expect(stored()).toMatchObject({ active: false, failedReads: LOAN_READ_FAIL_NOTICE });
    fx.loans = [lowLoan];
    await run();
    expect(stored()).toMatchObject({ failedReads: 0, active: true });
    expect(fx.sent[1]).toContain('Loan warning');
  });

  it('after a close that starts a weekend: one heads-up per watched loan with its health if Monday opens at Base’s price', async () => {
    const healthy: WalletLoan = { ...lowLoan, collateral: [{ ...lowLoan.collateral[0], aeroPriceUsd: 90 }], debtUsd: 40, healthFactor: 1.8 };
    fx.loans = [healthy];
    fx.breakClose = '2026-11-20';
    // Not delivered: tried again on the next tick.
    fx.deliver = false;
    await run();
    expect(stored().breakSent).toBeUndefined();
    fx.deliver = true;
    await run();
    expect(fx.sent).toHaveLength(1);
    // Far from the line (1.62 vs an alert at 1.20): calm, no rescue links.
    expect(fx.sent[0]).toContain("Market break check for 0x1234…7890: nothing urgent. Lowest health 1.62");
    expect(fx.sent[0]).toContain("shut until Monday's open");
    expect(fx.sent[0]).toContain("if Monday opens at Base's price, health 1.62 (1.80 now)");
    expect(fx.sent[0]).not.toContain('rescue=');
    expect(stored()).toMatchObject({ breakSent: '2026-11-20', active: false });
    // Once per break.
    await run();
    await run();
    expect(fx.sent).toHaveLength(1);
    // The next break gets its own.
    fx.breakClose = '2026-11-25';
    await run();
    expect(fx.sent).toHaveLength(2);
  });

  it('no heads-up for a wallet with no loan or one that can’t be read, and a warning due on the same tick goes first', async () => {
    fx.breakClose = '2026-11-20';
    fx.loans = [];
    await run();
    fx.loans = null;
    await run();
    expect(fx.sent).toEqual([]);
    fx.loans = [lowLoan];
    await run();
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]).toContain('Loan warning');
    expect(stored()).toMatchObject({ active: true });
    await run();
    expect(fx.sent).toHaveLength(2);
    expect(fx.sent[1]).toContain('Heads-up');
    // Already under the line: says so, not "close to".
    expect(fx.sent[1]).toContain('lowest health 1.11, below your alert at 1.20');
    // The warning's state is untouched by the heads-up.
    expect(stored()).toMatchObject({ active: true, breakSent: '2026-11-20' });
  });
  it('near the line (under 1.25x the alert threshold): an urgent heads-up with the rescue links', async () => {
    // 1.40 now, 1.26 at Base's price: above the 1.20 alert (no warning) but under 1.50.
    fx.loans = [{ ...lowLoan, collateral: [{ ...lowLoan.collateral[0], aeroPriceUsd: 90 }], debtUsd: 50, healthFactor: 1.4 }];
    fx.breakClose = '2026-11-20';
    await run();
    expect(fx.sent).toHaveLength(1);
    expect(fx.sent[0]).toContain('Heads-up for 0x1234…7890: lowest health 1.26, close to your alert at 1.20');
    expect(fx.sent[0]).toContain('https://afterbook.app/borrow?rescue=repay');
  });
});
