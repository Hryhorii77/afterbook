// /today, its card and its share text measure the gap against the same thing as the home page's hero.
import { describe, expect, it } from 'vitest';
import { todayReference } from '../lib/todaySnapshot';
import type { TapeRow } from '../lib/tape';

const row = (over: Partial<TapeRow>): TapeRow =>
  ({ symbol: 'GOOGLc', cashLastUsd: 290, closeUsd: 324.89, onchainMidUsd: 290.71, basisBp: 24.5, cashPriceType: 'after-hours', ...over }) as TapeRow;

describe('todayReference', () => {
  it('uses the live after-hours trade when the row has one', () => {
    expect(todayReference(row({}), { state: 'after-hours' })).toMatchObject({ bp: 24.5, cashUsd: 290, word: 'after-hours price', cardLabel: 'Cash after-hours' });
  });
  it('uses the close in after-hours when there is no trade yet', () => {
    const r = todayReference(row({ cashPriceType: 'regular', cashLastUsd: 324.89 }), { state: 'after-hours' });
    expect(r).toMatchObject({ cashUsd: 324.89, word: 'close', cardLabel: 'Cash close' });
    expect(r.bp).toBeCloseTo(((290.71 - 324.89) / 324.89) * 10_000, 6);
  });
  it('uses a pre-market trade before the open', () => {
    expect(todayReference(row({ cashPriceType: 'pre-market' }), { state: 'pre-market' })).toMatchObject({ word: 'pre-market price', cardLabel: 'Cash pre-market' });
  });
  it('uses the close overnight and on weekends, whatever the row holds', () => {
    for (const state of ['closed-overnight', 'closed-weekend', 'closed-holiday'] as const) {
      expect(todayReference(row({}), { state })).toMatchObject({ cashUsd: 324.89, word: 'close' });
    }
  });
  it('uses the live price while the market is open', () => {
    expect(todayReference(row({ cashPriceType: 'regular', basisBp: 3 }), { state: 'open' })).toMatchObject({ bp: 3, word: 'price', cardLabel: 'Cash price' });
  });
});
