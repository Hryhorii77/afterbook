// The headline gap figure and sentence every page and card leads with.
import { describe, expect, it } from 'vitest';
import { bp, bpClass, bpPct, gapSizeText } from '../lib/format';
import { todayShareText } from '../lib/share/shareText';

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
  it('names the venue first, so "on Base" never reads as where the cash price is', () => {
    expect(todayShareText('SNDKc', 15.9, 'price')).toBe('On Base, SNDKc is trading 0.16% (15.9 bp) above the cash price.');
  });
  it('keeps small gaps in bp only', () => {
    expect(gapSizeText(-3.2)).toBe('3.2 bp');
  });
  it('calls a gap that shows as 0.0 bp level, with no sign and no colour', () => {
    expect(todayShareText('GOOGLc', 0.02, 'price')).toBe('On Base, GOOGLc is trading level with the cash price.');
    expect(todayShareText('GOOGLc', -0.04, 'price')).toBe('On Base, GOOGLc is trading level with the cash price.');
    expect(bp(0.02)).toBe('0.0 bp');
    expect(bp(-0.04)).toBe('0.0 bp');
    expect(bpClass(0.02)).toBe('');
    expect(bpClass(0.06)).toBe('basis-pos');
    expect(bpClass(-0.06)).toBe('basis-neg');
    expect(todayShareText('GOOGLc', -0.06, 'price')).toBe('On Base, GOOGLc is trading 0.1 bp below the cash price.');
  });
});
