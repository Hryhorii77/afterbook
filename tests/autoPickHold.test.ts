import { describe, expect, it } from 'vitest';
import { buildTodaySnapshot } from '@/lib/market/todaySnapshot';
import { detectEvents } from '@/lib/alerts/liveAlerts';
import type { TapeRow } from '@/lib/market/tape';

// A held new listing (ANTc) with the biggest gap and a deep pool never leads /today, the home card or live alerts.
const row = (symbol: string, basisBp: number, depthUsd: number) =>
  ({ symbol, cashTicker: symbol.slice(0, -1), basisBp, depthUsd, cashLastUsd: 100, onchainMidUsd: 100 + basisBp / 100, cashPriceType: 'regular', closeUsd: 100, closeAsOfMs: 0 }) as unknown as TapeRow;
const rows = [row('ANTc', 900, 5_000_000), row('NVDAc', 40, 2_000_000), row('AMZNc', -25, 1_500_000)];

describe('new listings held out of what leads the page', () => {
  it('the headline gap (and so the opening stock) skips ANTc', () => {
    const snap = buildTodaySnapshot({ rows, session: { state: 'open' } } as never);
    expect(snap.headline?.symbol).toBe('NVDAc');
  });
  it("live alerts neither fire on ANTc nor name it as the day's gap", () => {
    const first = detectEvents(null, { session: { state: 'pre-market' }, rows } as never);
    const { events } = detectEvents(first.next, { session: { state: 'open' }, rows } as never);
    const text = JSON.stringify(events);
    expect(text).not.toContain('ANTc');
    expect(text).toContain('NVDAc');
  });
});
