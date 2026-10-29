// The headline gap figure and sentence every page and card leads with.
import { describe, expect, it } from 'vitest';
import { bpPct, gapSizeText } from '../lib/format';
import { todayShareText } from '../lib/shareText';

describe('bpPct', () => {
  it.each([
    [15.9, '+0.16%'],
    [-1103, '-11.03%'],
    [-0.3, '0.00%'],
    [0.4, '0.00%'],
    [null, '—'],
  ])('%s bp -> %s', (n, want) => {
    expect(bpPct(n)).toBe(want);
  });
});

describe('gap sentence', () => {
  it('names the venue first, so "on Aero" never reads as where the cash price is', () => {
    expect(todayShareText('SNDKc', 15.9, 'price')).toBe('On Aero, SNDKc is trading 0.16% (15.9 bp) above the cash price.');
  });
  it('keeps small gaps in bp only', () => {
    expect(gapSizeText(-3.2)).toBe('3.2 bp');
  });
});
