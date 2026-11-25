import { describe, expect, it, vi, beforeEach } from 'vitest';

// /today's open leaderboard, computed by the daily cron and saved as one key (2026-11-25). Offline: Redis and the
// history reads are fakes.
const fx = vi.hoisted(() => ({ store: new Map<string, unknown>(), stats: {} as Record<string, number | null>, sets: 0 }));
vi.mock('../lib/server/redis', () => ({
  redis: {
    get: async (k: string) => fx.store.get(k) ?? null,
    set: async (k: string, v: unknown) => (fx.sets++, fx.store.set(k, v), 'OK'),
  },
}));
vi.mock('../lib/stocks/tokens', () => ({ STOCKS: [{ symbol: 'NVDAc' }, { symbol: 'AAPLc' }, { symbol: 'MSFTc' }] }));
vi.mock('../lib/market/history', () => ({
  STATS_LOOKBACK_MS: 30 * 86_400_000,
  getOpenSnapStats: async (sym: string) => {
    const p = fx.stats[sym];
    if (p === undefined) throw new Error('read failed');
    return p == null ? null : { days30: 20, reverted30: 0, revertedPct30: p, days90: 20, reverted90: 0, revertedPct90: p };
  },
}));

import { computeOpenLeaderboard, readOpenLeaderboard, refreshOpenLeaderboard } from '../lib/market/openLeaderboard';

beforeEach(() => {
  fx.store.clear();
  fx.sets = 0;
  fx.stats = { NVDAc: 40, AAPLc: 90, MSFTc: null };
});

describe('open leaderboard', () => {
  it('keeps stocks with enough sessions, most often reverting first; a failed read just drops that stock', async () => {
    fx.stats = { NVDAc: 40, AAPLc: 90 }; // MSFTc's read throws
    expect((await computeOpenLeaderboard()).map((r) => r.symbol)).toEqual(['AAPLc', 'NVDAc']);
  });
  it('the cron saves it and the page reads it back; a dry run saves nothing', async () => {
    expect(await refreshOpenLeaderboard({ save: false })).toBe(2);
    expect(await readOpenLeaderboard()).toBeNull();
    await refreshOpenLeaderboard({ now: 1000 });
    expect((await readOpenLeaderboard())?.map((r) => r.symbol)).toEqual(['AAPLc', 'NVDAc']);
  });
  it('an empty result never replaces a good saved one', async () => {
    await refreshOpenLeaderboard();
    fx.stats = { NVDAc: null, AAPLc: null, MSFTc: null };
    await refreshOpenLeaderboard();
    expect(fx.sets).toBe(1);
    expect((await readOpenLeaderboard())?.length).toBe(2);
  });
  it('a malformed or empty saved value reads as none, so the page computes it', async () => {
    fx.store.set('today:openleaderboard', { rows: 'x' });
    expect(await readOpenLeaderboard()).toBeNull();
    fx.store.set('today:openleaderboard', { at: 1, rows: [] });
    expect(await readOpenLeaderboard()).toBeNull();
    // A bad row anywhere (review of #243): none, so the page computes rather than crash.
    fx.store.set('today:openleaderboard', { at: 1, rows: [{}] });
    expect(await readOpenLeaderboard()).toBeNull();
    fx.store.set('today:openleaderboard', { at: 1, rows: [{ symbol: 'NVDAc', stats: { days30: 20, revertedPct30: 50 } }, { symbol: 'AAPLc', stats: { days30: 'x', revertedPct30: 50 } }] });
    expect(await readOpenLeaderboard()).toBeNull();
    fx.store.set('today:openleaderboard', { at: Number.NaN, rows: [{ symbol: 'NVDAc', stats: { days30: 20, revertedPct30: 50 } }] });
    expect(await readOpenLeaderboard()).toBeNull();
    fx.store.set('today:openleaderboard', { at: 1, rows: [{ symbol: 'NVDAc', stats: { days30: 20, revertedPct30: 50 } }] });
    expect(await readOpenLeaderboard()).toHaveLength(1);
  });
});
