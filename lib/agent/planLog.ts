// The trade plan's log, kept in the visitor's browser (localStorage, owner choice 2026-11-08).
import type { PlanLeg } from './plan';

export interface LoggedPlan {
  at: number;
  budgetUsd: number;
  explainedBy: 'claude' | 'fixed';
  legs: { symbol: string; verdict: PlanLeg['verdict']; usd?: number; priceUsd: number | null }[];
}

const VERDICTS = new Set(['buy', 'wait', 'skip']);

/** One saved plan, checked field by field: storage is the visitor's to edit (or an older page's
 *  format), and one bad entry must not take the page down. */
export function isLoggedPlan(v: unknown): v is LoggedPlan {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.at === 'number' &&
    Number.isFinite(p.at) &&
    typeof p.budgetUsd === 'number' &&
    Array.isArray(p.legs) &&
    p.legs.every((l) => {
      if (!l || typeof l !== 'object') return false;
      const leg = l as Record<string, unknown>;
      return (
        typeof leg.symbol === 'string' &&
        VERDICTS.has(leg.verdict as string) &&
        (leg.usd === undefined || (typeof leg.usd === 'number' && Number.isFinite(leg.usd))) &&
        (leg.priceUsd === null || (typeof leg.priceUsd === 'number' && Number.isFinite(leg.priceUsd)))
      );
    })
  );
}
