import { describe, expect, it } from 'vitest';
import { numbersAllowed } from '../lib/agent/explain';

const facts = {
  steps: [{ step: 'with a pool over $250,000 in every reading of the last 3 hours', count: 10 }],
  picks: [
    { symbol: 'MSFTc', weightPct: 34, usd: 4924.8, fillCostPct: 0.18, gapPct: -0.12 },
    { symbol: 'NVDAc', weightPct: 33, usd: 4780.2, fillCostPct: 0.05, gapPct: 0.3 },
  ],
  investedUsd: 14_485,
  cashUsd: 5_515,
  dropped: [{ symbol: 'NVOc', why: 'NVO reports earnings in 4 days (2026-11-17); you asked to wait within 7 days.' }],
};

describe('numbersAllowed', () => {
  it('accepts the facts’ numbers as given, rounded, signed or with k', () => {
    expect(numbersAllowed('MSFT gets $4,924.80 (34%) and NVDA $4,780.20; $5,515 stays as cash.', facts)).toBe(true);
    expect(numbersAllowed('About $4,925 in MSFT, a gap of -0.12%, and a cost near 0.2%.', facts)).toBe(true);
    expect(numbersAllowed('10 pools stayed over $250,000 for 3 hours; NVO reports on 2026-11-17.', facts)).toBe(true);
    expect(numbersAllowed('2 stocks, $14,485 in all.', facts)).toBe(true);
  });
  it('rejects an amount or percent that is not in the facts', () => {
    expect(numbersAllowed('MSFT gets $5,088.96 of your basket.', facts)).toBe(false);
    expect(numbersAllowed('MSFT is 40% of the basket.', facts)).toBe(false);
    expect(numbersAllowed('It could reach $600 a share.', facts)).toBe(false);
    expect(numbersAllowed('Keep 12 stocks.', facts)).toBe(false);
    // Strict on purpose: an amount rounded to thousands is not one of the basket's figures.
    expect(numbersAllowed('About $14.5k in all.', facts)).toBe(false);
  });
  it('refuses the ways around it a review found', () => {
    expect(numbersAllowed('About five thousand dollars in MSFT.', facts)).toBe(false);
    expect(numbersAllowed('MSFT gets $9 million.', facts)).toBe(false);
    expect(numbersAllowed('NVDA gets twenty percent.', facts)).toBe(false);
    expect(numbersAllowed('NVDA is 8% of the basket.', facts)).toBe(false); // a small number as a percent is not a count
    expect(numbersAllowed('A $5 buy of NVDA.', facts)).toBe(false);
    expect(numbersAllowed('A cost of .9% here.', facts)).toBe(false);
    expect(numbersAllowed('MSFT trades +0.12% over its close.', facts)).toBe(false);
    expect(numbersAllowed('MSFT trades -0.12% under its close, one swap per stock.', facts)).toBe(true);
  });
});
