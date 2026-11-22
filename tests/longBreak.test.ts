import { describe, expect, it } from 'vitest';
import { longBreakClose, nextOpenWeekday } from '../lib/market/marketClock';

// The close that starts a weekend or holiday break, for the loan heads-up (2026-11-22): set only between such a
// close and the next open, never on a plain weeknight or while the market is open.
describe('longBreakClose', () => {
  const at = (iso: string) => longBreakClose(new Date(iso));
  it('a Friday close starts the weekend break until Monday’s pre-market', () => {
    expect(at('2026-11-20T20:59:00Z')).toBeNull(); // Friday 15:59 ET, open
    expect(at('2026-11-20T21:05:00Z')).toBe('2026-11-20');
    expect(at('2026-11-22T15:00:00Z')).toBe('2026-11-20'); // Sunday
    expect(at('2026-11-23T13:00:00Z')).toBeNull(); // Monday 8:00 ET, pre-market
    expect(nextOpenWeekday(new Date('2026-11-21T15:00:00Z'))).toBe('Monday');
  });
  it('a plain weeknight is not a break; a close before a holiday and an early close before a weekend are', () => {
    expect(at('2026-11-23T21:30:00Z')).toBeNull(); // Monday night
    expect(at('2026-11-25T21:30:00Z')).toBe('2026-11-25'); // Wednesday before Thanksgiving
    expect(at('2026-11-26T15:00:00Z')).toBe('2026-11-25'); // Thanksgiving
    expect(nextOpenWeekday(new Date('2026-11-26T15:00:00Z'))).toBe('Friday');
    expect(at('2026-11-27T17:30:00Z')).toBeNull(); // Friday 12:30 ET, early-close day still open
    expect(at('2026-11-27T18:05:00Z')).toBe('2026-11-27'); // after the 1 pm close
  });
  it('New Year’s Day 2027 makes Dec 31 the start of a long break; past the listed years it stays quiet', () => {
    expect(at('2026-12-31T21:30:00Z')).toBe('2026-12-31');
    expect(at('2027-01-01T15:00:00Z')).toBe('2026-12-31');
    expect(nextOpenWeekday(new Date('2027-01-01T15:00:00Z'))).toBe('Monday');
    expect(at('2028-01-07T22:00:00Z')).toBeNull();
  });
});
