// The tape's after-hours and pre-market cash price: the newest minute bar after the regular close, from
// the last 4 hours only (Yahoo's meta no longer carries postMarketPrice; GOOGL on 2026-10-28 traded
// $288 after hours against a $324.89 close).
import { describe, expect, it } from 'vitest';
import { lastBarAfter } from '../lib/tape';

const close = 1_793_131_200; // 16:00 ET
const bars = (rows: [number, number | null][]) => ({ timestamp: rows.map(([t]) => t), indicators: { quote: [{ close: rows.map(([, c]) => c) }] } });

describe('lastBarAfter', () => {
  it('takes the newest trade after the close', () => {
    const r = bars([[close - 60, 324.9], [close + 600, 300.1], [close + 1200, 290.5]]);
    expect(lastBarAfter(r, close, close + 1300)).toEqual({ price: 290.5, asOfMs: (close + 1200) * 1000 });
  });
  it('skips empty minutes at the end', () => {
    const r = bars([[close + 600, 300.1], [close + 660, null], [close + 720, null]]);
    expect(lastBarAfter(r, close, close + 800)).toEqual({ price: 300.1, asOfMs: (close + 600) * 1000 });
  });
  it('is null when nothing traded after the close', () => {
    const r = bars([[close - 120, 324.0], [close - 60, 324.9]]);
    expect(lastBarAfter(r, close, close + 600)).toBeNull();
  });
  it('ignores a trade older than 4 hours (last night, seen in early pre-market)', () => {
    const r = bars([[close + 3600, 290.5]]);
    expect(lastBarAfter(r, close, close + 3600 + 12 * 3600)).toBeNull();
  });
  it('is null on a malformed response', () => {
    expect(lastBarAfter(undefined, close)).toBeNull();
    expect(lastBarAfter({ timestamp: 'x' }, close)).toBeNull();
  });
});
