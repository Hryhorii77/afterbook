import { describe, expect, it } from 'vitest';
import { planCardContent } from '../lib/share/planCard';
import { cardPath } from '../lib/share/cardUrl';
import type { SavedPlan } from '../lib/agent/planLink';

const AT = Date.UTC(2026, 10, 25, 17, 26); // 12:26 ET

const leg = (symbol: string, verdict: 'buy' | 'wait' | 'skip', extra: Record<string, unknown> = {}) => ({
  symbol,
  name: symbol,
  verdict,
  reasons: [],
  gapBp: 9.5,
  gapAgainst: 'price',
  priceUsd: 143.93,
  depthUsd: 1_800_000,
  ...extra,
});

function plan(legs: ReturnType<typeof leg>[], via: 'telegram' | 'mcp' = 'telegram', budgetUsd = 10): SavedPlan {
  return {
    v: 1, id: 'G_nZKYNY2AznTOJL', at: AT, via, kind: 'plan', explanation: '', explainedBy: 'fixed',
    input: { symbols: legs.map((l) => l.symbol), budgetUsd, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2 },
    plan: { legs, budgetUsd, plannedUsd: 0, session: { state: 'open', label: 'Cash market open', nextOpenIso: '' }, createdAt: AT },
  } as unknown as SavedPlan;
}

describe('plan link share card', () => {
  it('says what the saved plan said: the buy, its amount, the gap and cost at the time, who made it and when', () => {
    const c = planCardContent(plan([leg('NVDAc', 'buy', { usd: 10, costBp: 6.4 })]));
    expect(c).toMatchObject({ kind: 'Plan', from: 'From the Telegram bot', made: 'Made Nov 25, 12:26 ET', headline: '1 buy · $10 of $10', more: 0 });
    expect(c.rows).toEqual([{ symbol: 'NVDAc', cashTicker: 'NVDA', verdict: 'Buy $10', buy: true, detail: '0.10% over the cash price · cost 0.06%' }]);
  });

  it('puts buys first, counts waits and skips, and keeps to four rows', () => {
    const c = planCardContent(
      plan(
        [
          leg('AAPLc', 'wait', { gapBp: -60 }),
          leg('NVDAc', 'buy', { usd: 20, costBp: 5 }),
          leg('METAc', 'skip', { gapBp: null }),
          leg('MSFTc', 'buy', { usd: 30, costBp: 4 }),
          leg('AMZNc', 'wait', { gapBp: 0.2, gapAgainst: 'close' }),
        ],
        'mcp',
        100,
      ),
    );
    expect(c.from).toBe('From an agent');
    expect(c.headline).toBe('2 buys, 2 waits, 1 skip · $50 of $100');
    expect(c.rows.map((r) => [r.symbol, r.verdict])).toEqual([['MSFTc', 'Buy $30'], ['NVDAc', 'Buy $20'], ['AAPLc', 'Wait'], ['AMZNc', 'Wait']]);
    expect(c.rows[2].detail).toBe('0.60% under the cash price');
    expect(c.rows[3].detail).toBe('at the cash close');
    expect(c.more).toBe(1);
  });

  it('a plan with no buy says so', () => {
    expect(planCardContent(plan([leg('NVDAc', 'wait')])).headline).toBe('1 wait · $0 of $10');
  });

  it('a basket shows its weights and amounts', () => {
    const saved = {
      v: 1, id: 'AbCdEfGhIjKlMnOp', at: AT, via: 'x402', kind: 'basket', explanation: '', explainedBy: 'fixed',
      brief: {
        input: {}, investedUsd: 100, basket: [{ symbol: 'NVDAc', weightPct: 50 }, { symbol: 'MSFTc', weightPct: 50 }],
        picks: [
          { symbol: 'NVDAc', weightPct: 50, usd: 50, costBp: 4, gapBp: -12, gapAgainst: 'price' },
          { symbol: 'MSFTc', weightPct: 50, usd: 50, costBp: 5.5, gapBp: null, gapAgainst: 'price' },
        ],
      },
    } as unknown as SavedPlan;
    const c = planCardContent(saved);
    expect(c.kind).toBe('Basket');
    expect(c.headline).toBe('$100 across 2 stocks');
    expect(c.rows[0]).toMatchObject({ symbol: 'NVDAc', verdict: '50%', detail: '$50 · 0.12% under the cash price · cost 0.04%' });
    expect(c.rows[1].detail).toBe('$50 · no gap reading · cost 0.06%');
  });

  it('the card URL carries only the plan id (and theme, version)', () => {
    expect(cardPath({ page: 'plan', id: 'G_nZKYNY2AznTOJL' }, { theme: 'light' })).toMatch(/^\/card\?page=plan&id=G_nZKYNY2AznTOJL&theme=light&v=\d+$/);
  });
});
