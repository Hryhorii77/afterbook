import { describe, expect, it } from 'vitest';
import { parsePrefill, prefillPath } from '../lib/swap/prefill';

// A stock page link that arrives with a buy amount filled in (2026-11-26). It only fills the page's amount.
describe('link prefill', () => {
  it('takes a buy amount in whole dollars, from $1 to the $25,000 swap cap', () => {
    expect(parsePrefill({ side: 'buy', usdc: '100' })).toBe(100);
    expect(parsePrefill({ usdc: '12' })).toBe(12); // no side: a buy
    expect(parsePrefill({ side: 'buy', usdc: '1' })).toBe(1);
    expect(parsePrefill({ side: 'buy', usdc: '25000' })).toBe(25_000);
  });
  it('ignores a sell, odd text, cents (the panel would show a cent less: 19.99 → 19.98), and anything outside $1 to $25,000', () => {
    for (const p of [
      { side: 'sell', usdc: '100' },
      { side: 'BUY', usdc: '100' },
      { side: 'buy', usdc: '25000.01' },
      { side: 'buy', usdc: '0.99' },
      { side: 'buy', usdc: '1e3' },
      { side: 'buy', usdc: '-5' },
      { side: 'buy', usdc: '1,000' },
      { side: 'buy', usdc: '10.005' },
      { side: 'buy', usdc: '19.99' },
      { side: 'buy', usdc: '12.5' },
      { side: 'buy', usdc: '١٠٠' }, // non-ASCII digits
      { side: 'buy', usdc: '1000000' },
      { side: 'buy', usdc: 'NaN' },
      { side: 'buy', usdc: '' },
      { side: 'buy' },
      {},
    ]) expect(parsePrefill(p)).toBeNull();
  });
  it('builds the link with the amount, or without one when it isn’t allowed', () => {
    expect(prefillPath('NVDAc', 100)).toBe('/NVDAc?side=buy&usdc=100#execute');
    expect(prefillPath('NVDAc', 12.99)).toBe('/NVDAc?side=buy&usdc=12#execute'); // rounded down, never up
    expect(prefillPath('NVDAc', Number.NaN)).toBe('/NVDAc#execute');
    expect(prefillPath('NVDAc', 1_000_000)).toBe('/NVDAc#execute');
    expect(prefillPath('NVDAc', 0.5)).toBe('/NVDAc#execute');
    expect(prefillPath('NVDAc', null)).toBe('/NVDAc#execute');
  });
});
