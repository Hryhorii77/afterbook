// Query strings of the paid agent routes (/api/v1/x402/plan, /api/v1/x402/basket) → the same inputs the
// page routes parse, through the same parsers (parsePlanInput, parseBriefInput), so the limits and the
// messages are the page's. GET like the other x402 routes. No `note`: on the page it is the person's own
// words for Claude to answer; an agent's free text would only be prompt surface, and the numbers decide.
// Unknown parameters are refused, so a typo ("budget=") is a 400 (not charged) instead of a silent default.
import { parsePlanInput, type PlanInput } from './plan';
import { parseBriefInput, type BriefInput } from './brief';

const PLAN_PARAMS = ['symbols', 'budgetUsd', 'maxPremiumBp', 'maxCostBp', 'earningsDays'] as const;
const BASKET_PARAMS = ['theme', 'exclude', 'minStocks', 'budgetUsd', 'cashPct', 'maxPremiumBp', 'maxCostBp', 'earningsDays'] as const;

function unknownParam(params: URLSearchParams, allowed: readonly string[]): string | null {
  for (const k of params.keys()) {
    if (!allowed.includes(k)) return `unknown parameter: ${k.slice(0, 30)} (allowed: ${allowed.join(', ')})`;
  }
  return null;
}

/** "a,b" → ["a", "b"]; missing or empty → []. */
const list = (v: string | null) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** A present parameter as given (the parser reads numbers from strings); missing → undefined (its default). */
const opt = (params: URLSearchParams, k: string) => params.get(k) ?? undefined;

export function planFromQuery(params: URLSearchParams, known: (symbol: string) => boolean): PlanInput | string {
  const bad = unknownParam(params, PLAN_PARAMS);
  if (bad) return bad;
  return parsePlanInput(
    {
      symbols: list(params.get('symbols')),
      budgetUsd: opt(params, 'budgetUsd'),
      maxPremiumBp: opt(params, 'maxPremiumBp'),
      maxCostBp: opt(params, 'maxCostBp'),
      earningsDays: opt(params, 'earningsDays'),
    },
    known,
  );
}

export function basketFromQuery(params: URLSearchParams): BriefInput | string {
  const bad = unknownParam(params, BASKET_PARAMS);
  if (bad) return bad;
  return parseBriefInput({
    theme: opt(params, 'theme'),
    exclude: list(params.get('exclude')),
    minStocks: opt(params, 'minStocks'),
    budgetUsd: opt(params, 'budgetUsd'),
    cashPct: opt(params, 'cashPct'),
    maxPremiumBp: opt(params, 'maxPremiumBp'),
    maxCostBp: opt(params, 'maxCostBp'),
    earningsDays: opt(params, 'earningsDays'),
  });
}
