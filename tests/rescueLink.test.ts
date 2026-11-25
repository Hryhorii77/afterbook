import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WalletLoan } from '../lib/lending/loanHealth';
import { loanAlertText, loansReplyText } from '../lib/lending/loanHealth';
import { parseRescuePreset, rescueLinks, rescuePath, rescueScenario } from '../lib/lending/rescueLink';

// Loan warnings link to the in-app Aave panel with the rescue planner preset; the paid loan-health route
// returns the same links. Offline: the chain read and the payment layer are fakes.
vi.mock('server-only', () => ({}));
const fx = vi.hoisted(() => ({ loans: [] as unknown[], fail: false }));
vi.mock('@x402/next', () => ({ withX402: (h: unknown) => h }));
vi.mock('../lib/server/x402', () => ({
  x402Configured: true,
  getX402Server: () => ({}),
  X402_PAYOUT_ADDRESS: '0x0000000000000000000000000000000000000001',
  X402_NETWORK: 'eip155:8453',
  X402_PRICE: '$0.02',
}));
vi.mock('../lib/share/siteUrl', () => ({ siteUrl: 'https://afterbook.app' }));
vi.mock('../lib/lending/loanPositions', () => ({
  getWalletLoans: async () => {
    if (fx.fail) throw new Error('rpc down');
    return fx.loans;
  },
}));

import { GET } from '../app/api/v1/x402/loan-health/route';

const loan = (venue: 'aave' | 'morpho', healthFactor: number, aeroVsOracle: number | null): WalletLoan => ({
  venue,
  collateral: [{ symbol: 'NVDAc', amount: 10, oraclePriceUsd: 100, aeroPriceUsd: aeroVsOracle == null ? null : 100 * aeroVsOracle, collateralFactor: 0.7 }],
  debtUsd: 500,
  healthFactor,
});

describe('rescue links', () => {
  it('never carry a wallet or an amount: only rescue, fall and target, each one of the planner’s own choices', () => {
    for (const hf of [0.95, 1.1, 1.4, 2.5]) {
      for (const gap of [null, 0.5, 0.88, 1, 1.2]) {
        for (const threshold of [1.01, 1.2, 1.5, 3]) {
          const links = rescueLinks(loan('aave', hf, gap), threshold, 'https://afterbook.app')!;
          for (const href of [links.repayUrl, links.addUrl]) {
            const url = new URL(href);
            expect(url.origin + url.pathname + url.hash).toBe('https://afterbook.app/borrow#borrow-here');
            expect([...url.searchParams.keys()].sort()).toEqual(['fall', 'rescue', 'target']);
            expect(parseRescuePreset(url.searchParams)).not.toBeNull();
            expect(href).not.toMatch(/0x/i);
          }
        }
      }
    }
  });

  it('sets the fall to where Aero’s price would take the oracle, and the target above the alert line', () => {
    // Aero 12% under the oracle: the planner's next fall at or above 12% is 20%.
    expect(rescueScenario(loan('aave', 1.4, 0.88), 1.2)).toEqual({ fall: 0.2, target: 1.3 });
    // No gap, or no Aero price: prices as they are.
    expect(rescueScenario(loan('aave', 1.1, 1), 1.2)).toEqual({ fall: 0, target: 1.3 });
    expect(rescueScenario(loan('aave', 1.1, null), 1.5)).toEqual({ fall: 0, target: 2 });
    // Beyond the planner's largest choices: its largest.
    expect(rescueScenario(loan('aave', 2, 0.5), 2.5)).toEqual({ fall: 0.3, target: 2 });
  });

  it('builds /borrow links for Aave only, and reads back only the planner’s own choices', () => {
    expect(rescueLinks(loan('morpho', 1.1, 1), 1.2, 'https://afterbook.app')).toBeNull();
    const links = rescueLinks(loan('aave', 1.4, 0.88), 1.2, 'https://afterbook.app')!;
    expect(links.repayUrl).toBe('https://afterbook.app/borrow?rescue=repay&fall=0.2&target=1.3#borrow-here');
    expect(links.addUrl).toBe('https://afterbook.app/borrow?rescue=add&fall=0.2&target=1.3#borrow-here');
    const q = (path: string) => new URL(path, 'https://x').searchParams;
    expect(parseRescuePreset(q(rescuePath({ action: 'add', fall: 0.1, target: 1.5 })))).toEqual({ action: 'add', fall: 0.1, target: 1.5 });
    expect(parseRescuePreset(q('/borrow?rescue=repay&fall=0.25&target=1.3'))).toBeNull();
    expect(parseRescuePreset(q('/borrow?rescue=repay&fall=0.2&target=9'))).toBeNull();
    expect(parseRescuePreset(q('/borrow?rescue=withdraw&fall=0.2&target=1.3'))).toBeNull();
    expect(parseRescuePreset(q('/borrow?rescue=repay&amount=1000&fall=0.2&target=1.3'))).toEqual({ action: 'repay', fall: 0.2, target: 1.3 });
  });

  it('puts the links in the loan warning only when there are some', () => {
    const l = loan('aave', 1.15, 1);
    const withLinks = loanAlertText('0x1234567890123456789012345678901234567890', [l], 1.2, rescueLinks(l, 1.2, 'https://afterbook.app'));
    expect(withLinks).toContain('Repay USDC: https://afterbook.app/borrow?rescue=repay&fall=0&target=1.3#borrow-here');
    expect(withLinks).toContain('Add collateral: https://afterbook.app/borrow?rescue=add');
    expect(withLinks.endsWith('Not advice. Afterbook never touches your funds.')).toBe(true);
    expect(loanAlertText('0x1234567890123456789012345678901234567890', [loan('morpho', 1.15, 1)], 1.2, null)).not.toContain('borrow?rescue');
  });

  it('/loans in the bot: rescue links only near the alert line (under 1.25x it), a calm line otherwise (2026-11-25)', () => {
    const W = '0x1234567890123456789012345678901234567890';
    const near = loan('aave', 1.45, 1); // 1.45 < 1.2 × 1.25 = 1.5
    const nearText = loansReplyText(W, [near], 1.2, rescueLinks(near, 1.2, 'https://afterbook.app'));
    expect(nearText).toContain('close to your alert at 1.20');
    expect(nearText).toContain('Repay USDC: https://afterbook.app/borrow?rescue=repay');
    expect(nearText).toContain('Add collateral: https://afterbook.app/borrow?rescue=add');
    expect(nearText).not.toMatch(/amount=|0x[0-9a-f]{40}.*borrow/i); // no amount or wallet in a link
    const below = loan('aave', 1.1, 1);
    expect(loansReplyText(W, [below], 1.2, rescueLinks(below, 1.2, 'https://afterbook.app'))).toContain('below your alert at 1.20');
    // Aero's price counts: health fine at the oracle, near the line at Base's price.
    const byAero = loan('aave', 2, 0.7);
    expect(loansReplyText(W, [byAero], 1.2, rescueLinks(byAero, 1.2, 'https://afterbook.app'))).toContain('Repay USDC:');
    const calm = loan('aave', 2, 1);
    const calmText = loansReplyText(W, [calm], 1.2, rescueLinks(calm, 1.2, 'https://afterbook.app'));
    expect(calmText).toContain('Nothing urgent: lowest health 2.00, well above your alert at 1.20. Rescue links show here when it gets within 25% of it.');
    expect(calmText).not.toContain('borrow?rescue');
    const morpho = loansReplyText(W, [loan('morpho', 1.1, 1)], 1.2, null);
    expect(morpho).toContain('Morpho loans have no in-app panel');
    expect(morpho).not.toContain('borrow?rescue');
    expect(loansReplyText(W, [], 1.2, null)).toContain('no Aave or Morpho stock loans');
    // Per loan: a near Morpho loan next to a healthy Aave loan gets the Morpho pointer, not the Aave links.
    const healthyAave = loan('aave', 2, 1);
    const mixed = loansReplyText(W, [healthyAave, loan('morpho', 1.1, 1)], 1.2, rescueLinks(healthyAave, 1.2, 'https://afterbook.app'));
    expect(mixed).toContain('Morpho loans have no in-app panel');
    expect(mixed).not.toContain('borrow?rescue');
    // Morpho only and calm: no promise of rescue links.
    expect(loansReplyText(W, [loan('morpho', 2, 1)], 1.2, null)).not.toContain('Rescue links');
  });
});

let ip = 0;
const get = (q: string) => GET(new NextRequest(`https://afterbook.app/api/v1/x402/loan-health${q}`, { headers: { 'x-forwarded-for': `10.7.0.${++ip}` } }));

describe('GET /api/v1/x402/loan-health (payment stubbed)', () => {
  it('reports each loan with both healths and, for Aave, the links', async () => {
    fx.fail = false;
    fx.loans = [loan('aave', 1.4, 0.88), loan('morpho', 2, 1)];
    const body = await (await get('?wallet=0x1234567890123456789012345678901234567890&threshold=1.3')).json();
    expect(body.wallet).toBe('0x1234567890123456789012345678901234567890');
    expect(body.loans[0]).toMatchObject({ venue: 'aave', healthFactor: 1.4, healthAtAero: 1.232, worstHealth: 1.232, belowThreshold: true });
    expect(body.loans[0].actions.repayUrl).toBe('https://afterbook.app/borrow?rescue=repay&fall=0.2&target=1.5#borrow-here');
    expect(body.loans[1]).toMatchObject({ venue: 'morpho', belowThreshold: false, actions: null });
  });

  it('refuses bad input with a 400 and a failed read with a 502 (neither is charged)', async () => {
    expect((await get('?wallet=nope')).status).toBe(400);
    expect((await get('?wallet=0x1234567890123456789012345678901234567890&threshold=0.5')).status).toBe(400);
    expect((await get('?wallet=0x1234567890123456789012345678901234567890&amount=5')).status).toBe(400);
    fx.fail = true;
    expect((await get('?wallet=0x1234567890123456789012345678901234567890')).status).toBe(502);
  });
});
