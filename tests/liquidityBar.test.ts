import { describe, expect, it, vi } from 'vitest';
vi.mock('next/cache', () => ({ unstable_cache: (f: unknown) => f }));
const held = vi.hoisted(() => ({ bar: null as unknown }));
vi.mock('@/lib/server/redis', () => ({ redis: { get: async () => held.bar } }));
import { liquidBarRow, LIQUID_BAR_WINDOW_MS, getLiquidBar } from '@/lib/market/liquidityBar';
import { liquidLabel } from '@/lib/market/liquidLabel';

const NOW = Date.UTC(2026, 10, 22, 13);
const SLOT = 5 * 60_000;
/** Samples every 5 minutes back over `hours`, with the depth given by `at(hoursAgo)`; `skip` drops some. */
const series = (hours: number, at: (h: number) => number | null, skip = (_i: number) => false) =>
  Array.from({ length: Math.floor((hours * 3_600_000) / SLOT) + 1 }, (_, i) => i)
    .filter((i) => !skip(i))
    .map((i) => ({ ts: NOW - i * SLOT, d: { NVDAc: at((i * SLOT) / 3_600_000) } }));

describe('liquidBarRow', () => {
  it('liquid when every reading over 72 hours is at least $100k', () => {
    const r = liquidBarRow(series(72, () => 1_700_000), 'NVDAc', NOW);
    expect(r).toMatchObject({ status: 'liquid', lowUsd: 1_700_000 });
    expect(liquidLabel(r)).toBe('Liquid · 72h low $1.70M');
  });
  it('thin when one reading dips under, as with liquidity added and pulled', () => {
    const r = liquidBarRow(series(72, (h) => (h > 40 && h < 41 ? 20_000 : 230_000)), 'NVDAc', NOW);
    expect(r).toMatchObject({ status: 'thin', lowUsd: 20_000 });
    expect(liquidLabel(r)).toMatch(/^Thin · 72h low \$20k/);
  });
  it('a pool sitting at ~$51k is thin', () => {
    expect(liquidBarRow(series(72, () => 51_000), 'NVDAc', NOW).status).toBe('thin');
  });
  it('measuring until the window is covered, unless a dip already shows', () => {
    expect(liquidBarRow(series(10, () => 900_000), 'NVDAc', NOW).status).toBe('measuring');
    expect(liquidBarRow(series(10, () => 40_000), 'NVDAc', NOW).status).toBe('thin');
    expect(liquidLabel(liquidBarRow([], 'NVDAc', NOW))).toBe('Liquidity: measuring');
  });
  it('measuring when too many readings are missing or failed', () => {
    expect(liquidBarRow(series(72, () => 900_000, (i) => i % 3 === 0), 'NVDAc', NOW).status).toBe('measuring');
    expect(liquidBarRow(series(72, (h) => (h < 30 ? null : 900_000)), 'NVDAc', NOW).status).toBe('measuring');
  });
  it('a lone $0 between good readings is a failed read, not a dip', () => {
    expect(liquidBarRow(series(72, (h) => (Math.abs(h - 20) < 0.01 ? 0 : 500_000)), 'NVDAc', NOW).status).toBe('liquid');
    // Two zeros in a row, or one at the edge, still count.
    expect(liquidBarRow(series(72, (h) => (h > 20 && h < 20.2 ? 0 : 500_000)), 'NVDAc', NOW).status).toBe('thin');
  });
  it('the $0 rule stays narrow', () => {
    // A $0 on the newest reading always counts (a pool emptied just before the daily compute).
    expect(liquidBarRow(series(72, (h) => (h === 0 ? 0 : 500_000)), 'NVDAc', NOW).status).toBe('thin');
    // A $0 between neighbours under the bar counts too.
    expect(liquidBarRow(series(72, (h) => (Math.abs(h - 20) < 0.01 ? 0 : 90_000)), 'NVDAc', NOW).lowUsd).toBe(0);
    // Coverage is by distinct slot: doubled samples don't count twice.
    const half = series(72, () => 500_000, (i) => i % 2 === 0);
    expect(liquidBarRow([...half, ...half], 'NVDAc', NOW).status).toBe('measuring');
    // Zeros every other slot: only two are dropped, the rest count.
    expect(liquidBarRow(series(72, (h) => (Math.round(h * 12) % 2 === 1 && h < 5 ? 0 : 500_000)), 'NVDAc', NOW).status).toBe('thin');
    // A $0 with no good reading close by (hours of failed reads around it) counts.
    expect(liquidBarRow(series(72, (h) => (h > 30 && h < 34 ? (Math.abs(h - 32) < 0.01 ? 0 : null) : 500_000)), 'NVDAc', NOW).status).not.toBe('liquid');
  });
  it('ignores readings outside the window', () => {
    const old = { ts: NOW - LIQUID_BAR_WINDOW_MS - 3_600_000, d: { NVDAc: 1 } };
    expect(liquidBarRow([...series(72, () => 500_000), old], 'NVDAc', NOW).status).toBe('liquid');
  });
});

describe('getLiquidBar', () => {
  it('shows a fresh bar and hides one the cron hasn\u2019t refreshed in 48 hours', async () => {
    held.bar = { at: NOW - 20 * 3_600_000, rows: { NVDAc: { status: 'liquid', lowUsd: 1, coverage: 1 } } };
    expect(await getLiquidBar(NOW)).not.toBeNull();
    held.bar = { at: NOW - 49 * 3_600_000, rows: {} };
    expect(await getLiquidBar(NOW)).toBeNull();
    held.bar = null;
    expect(await getLiquidBar(NOW)).toBeNull();
  });
});
