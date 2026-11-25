import { describe, expect, it } from 'vitest';
import { routeOf, summarizePaidCalls, type PaidCall } from '../lib/server/x402Ledger';

// Paid x402 calls for /traction (2026-11-25): the route from the paid resource's URL, and the totals.
describe('x402 paid calls', () => {
  it('names the route from the resource URL, and "other" for anything else', () => {
    expect(routeOf('https://afterbook.app/api/v1/x402/plan?symbols=NVDAc&budgetUsd=100')).toBe('plan');
    expect(routeOf('https://afterbook.app/api/v1/x402/liquidation-capacity/')).toBe('liquidation-capacity');
    expect(routeOf('/api/v1/x402/tape')).toBe('tape');
    expect(routeOf('https://afterbook.app/api/v1/x402/nope')).toBe('other');
    expect(routeOf(undefined)).toBe('other');
  });
  it('counts calls and USDC per route, within a window', () => {
    const call = (route: PaidCall['route'], amount: string, at: number): PaidCall => ({ tx: `0x${String(at).padStart(64, '0')}`, route, amount, payer: '0xabc', at });
    const calls = [call('plan', '50000', 100), call('plan', '50000', 200), call('tape', '20000', 300), call('quote', 'junk', 400)];
    const all = summarizePaidCalls(calls);
    expect(all.calls).toBe(3);
    expect(all.usdc).toBeCloseTo(0.12, 9);
    expect(all.byRoute.plan).toEqual({ calls: 2, usdc: 0.1 });
    expect(summarizePaidCalls(calls, 150).byRoute.plan?.calls).toBe(1);
  });
});
