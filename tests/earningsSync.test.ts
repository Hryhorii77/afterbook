import { describe, expect, it, vi, beforeEach } from 'vitest';

// Offline: no Redis, no Nasdaq. The cron's writes are recorded instead of sent.
vi.mock('@/lib/server/redis', () => ({ redis: null }));
vi.mock('../lib/server/redis', () => ({ redis: null }));
vi.mock('@/lib/server/sharedSecret', () => ({ cronAuthorized: () => true }));
vi.mock('@/lib/stocks/earningsHistory', () => ({ syncEarningsMovesForDate: async () => 0 }));
const w = vi.hoisted(() => ({ records: [] as [string, string | null][], synced: 0, failDay: null as string | null, nvdaDay: null as string | null }));
vi.mock('@/lib/stocks/earningsCalendar', async (orig) => {
  const real = await orig<typeof import('../lib/stocks/earningsCalendar')>();
  return {
    ...real,
    recordNextEarnings: async (symbol: string, date: string | null) => void w.records.push([symbol, date]),
    recordEarningsSynced: async () => void w.synced++,
    scanNextEarnings: (tickers: string[], now: number) =>
      real.scanNextEarnings(tickers, now, async (d) => (d === w.failDay ? null : d === w.nvdaDay ? new Set(['NVDA']) : new Set())),
  };
});

import { fetchNasdaqEarningsForDate, EARNINGS_SCAN_DAYS } from '../lib/stocks/earningsCalendar';
import { GET } from '../app/api/cron/earnings-sync/route';
import { NextRequest } from 'next/server';

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('fetchNasdaqEarningsForDate', () => {
  it('tells a day with no reports from a failed fetch', async () => {
    // Nasdaq's real answer for a Sunday (checked 2026-11-08): data present, rows null.
    expect(await fetchNasdaqEarningsForDate('2026-11-08', reply(200, { data: { rows: null }, status: { rCode: 200 } }))).toEqual(new Set());
    expect(await fetchNasdaqEarningsForDate('2026-11-10', reply(200, { data: { rows: [{ symbol: 'NVDA' }, { symbol: 7 }] }, status: { rCode: 200 } }))).toEqual(new Set(['NVDA']));
    expect(await fetchNasdaqEarningsForDate('d', reply(503, {}))).toBeNull();
    expect(await fetchNasdaqEarningsForDate('d', reply(200, { data: null, status: { rCode: 400 } }))).toBeNull();
    expect(await fetchNasdaqEarningsForDate('d', reply(200, { data: { rows: 'x' } }))).toBeNull();
    expect(await fetchNasdaqEarningsForDate('d', (async () => { throw new Error('timeout'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('scanNextEarnings', () => {
  it('scans 15 days, keeps the earliest date and lists failed days', async () => {
    // The module's scanNextEarnings is wrapped above for the cron tests; test the real one.
    const { scanNextEarnings } = await vi.importActual<typeof import('../lib/stocks/earningsCalendar')>('../lib/stocks/earningsCalendar');
    const now = Date.parse('2026-11-08T13:00:00Z');
    const seen: string[] = [];
    const { next, failedDays } = await scanNextEarnings(['NVDA', 'AAPL'], now, async (d) => {
      seen.push(d);
      if (d === '2026-11-09') return null;
      return d === '2026-11-17' || d === '2026-11-20' ? new Set(['NVDA']) : new Set();
    });
    expect(EARNINGS_SCAN_DAYS).toBe(15);
    expect(seen).toHaveLength(15);
    expect(seen.at(-1)).toBe('2026-11-22');
    expect(next).toEqual(new Map([['NVDA', '2026-11-17']]));
    expect(failedDays).toEqual(['2026-11-09']);
  });
});

describe('earnings-sync cron', () => {
  beforeEach(() => Object.assign(w, { records: [], synced: 0, failDay: null, nvdaDay: null }));
  const run = async () => (await GET(new NextRequest('http://local/api/cron/earnings-sync'))).json();
  const today = () => new Date().toISOString().slice(0, 10);
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  it('after a full scan, clears missing dates and records the sync time', async () => {
    w.nvdaDay = inDays(3);
    const body = await run();
    expect(body).toMatchObject({ ok: true, found: 1, failedDays: [] });
    expect(w.records).toContainEqual(['NVDAc', inDays(3)]);
    expect(w.records).toContainEqual(['AAPLc', null]);
    expect(w.synced).toBe(1);
  });
  it('with a failed day, only adds found dates: nothing deleted, no sync time', async () => {
    w.failDay = today();
    w.nvdaDay = inDays(3);
    const body = await run();
    expect(body).toMatchObject({ ok: false, failedDays: [today()] });
    expect(w.records).toEqual([['NVDAc', inDays(3)]]);
    expect(w.synced).toBe(0);
  });
});
