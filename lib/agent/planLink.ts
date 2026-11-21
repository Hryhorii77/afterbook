// A plan an agent made (x402 or MCP), saved so a person can open it as afterbook.app/plan/<id> and sign its
// buys here: through the checked swap (one per stock) or, for a basket, the basket buy (one signature with
// Base Account), with the Builder Code on every call. Pure maths, safe for the browser; the store and the
// recheck are server-only (lib/agent/savedPlan.ts, lib/agent/runPlan.ts).
//
// What the link carries (2026-11-21): the code's verdicts and sizes at the time the agent asked, never an
// agent's own numbers. When the page opens, the same checks run again on the same stocks with the same
// limits, and a buy is offered only where it still passes, at most the amount the agent was shown (the
// link's spending cap). Nothing here builds or signs a transaction.
import type { Plan, PlanInput, PlanLeg } from './plan';
import { AUTO_PICK_HOLD, PLAN_LIMITS } from './limits';
import type { Brief } from './brief';

/** Kept this long; after that the link says it has expired. */
export const PLAN_LINK_TTL_S = 7 * 24 * 3600;

/** 16 characters of base64url (96 random bits). */
export const PLAN_ID_RE = /^[A-Za-z0-9_-]{16}$/;

export type PlanLinkVia = 'x402' | 'mcp';

interface SavedBase {
  v: 1;
  id: string;
  at: number;
  via: PlanLinkVia;
  explanation: string;
  explainedBy: 'claude' | 'fixed';
}
export interface SavedStockPlan extends SavedBase {
  kind: 'plan';
  input: Omit<PlanInput, 'note'>;
  plan: Plan;
}
export interface SavedBasket extends SavedBase {
  kind: 'basket';
  brief: Brief;
}
export type SavedPlan = SavedStockPlan | SavedBasket;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A record read back from Redis: the fields the page relies on are there and of the right type. */
export function isSavedPlan(v: unknown): v is SavedPlan {
  if (!isObj(v) || v.v !== 1 || typeof v.id !== 'string' || !PLAN_ID_RE.test(v.id) || typeof v.at !== 'number') return false;
  if (v.via !== 'x402' && v.via !== 'mcp') return false;
  if (typeof v.explanation !== 'string' || (v.explainedBy !== 'claude' && v.explainedBy !== 'fixed')) return false;
  if (v.kind === 'plan') return isObj(v.input) && isObj(v.plan) && Array.isArray(v.plan.legs);
  if (v.kind === 'basket') return isObj(v.brief) && isObj(v.brief.input) && (v.brief.basket === null || Array.isArray(v.brief.basket));
  return false;
}

/** The stocks the saved plan said to buy, with the amount it showed for each. */
export function savedBuys(saved: SavedPlan): Map<string, number> {
  if (saved.kind === 'plan') {
    return new Map(saved.plan.legs.filter((l) => l.verdict === 'buy' && (l.usd ?? 0) > 0).map((l) => [l.symbol, l.usd as number]));
  }
  const b = saved.brief;
  if (!b.basket) return new Map();
  return new Map(b.basket.map((l) => [l.symbol, (b.investedUsd * l.weightPct) / 100]));
}

/** What the recheck runs: the same limits, only the stocks the plan said to buy, and for a basket the
 *  amount it invested. null when the plan had no buy (nothing to recheck or sign). */
export function recheckInput(saved: SavedPlan): PlanInput | null {
  const buys = [...savedBuys(saved).keys()];
  if (!buys.length) return null;
  const limits = saved.kind === 'plan' ? saved.input : saved.brief.input;
  return {
    symbols: buys,
    budgetUsd: saved.kind === 'plan' ? saved.input.budgetUsd : saved.brief.investedUsd,
    maxPremiumBp: limits.maxPremiumBp,
    maxCostBp: limits.maxCostBp,
    earningsDays: limits.earningsDays,
    note: '',
  };
}

export interface RecheckedBuy {
  symbol: string;
  /** What may be bought now: the lower of the fresh size and the saved one, whole dollars. */
  usd: number;
  /** The saved amount, when the fresh check sized it lower. */
  wasUsd?: number;
}

/** A stock plan's buys after the recheck (each stock sized on its own against its saved amount, so never
 *  over it; the cap here is a second guard): fresh verdicts, at most the amount the agent was shown. */
export function cappedBuys(saved: SavedStockPlan, fresh: PlanLeg[]): RecheckedBuy[] {
  const was = savedBuys(saved);
  const out: RecheckedBuy[] = [];
  for (const leg of fresh) {
    const cap = was.get(leg.symbol);
    // A new listing (AUTO_PICK_HOLD) is never offered from a link: an agent named it, not the person, who can
    // still buy it on its own page (review of #211).
    if (leg.verdict !== 'buy' || cap == null || leg.usd == null || AUTO_PICK_HOLD[leg.symbol]) continue;
    const usd = Math.floor(Math.min(leg.usd, cap));
    if (usd < PLAN_LIMITS.minLegUsd) continue;
    out.push(usd < Math.floor(cap) ? { symbol: leg.symbol, usd, wasUsd: Math.floor(cap) } : { symbol: leg.symbol, usd });
  }
  return out;
}

/** A basket is bought whole or not at all: every stock must still pass, at its full share (a stock the
 *  cost limit or the swap caps now cut would change the basket). The cap is the amount it invested. */
export function basketRecheck(saved: SavedBasket, fresh: PlanLeg[]): { ok: true; usd: number } | { ok: false; why: string[] } {
  const b = saved.brief;
  if (!b.basket) return { ok: false, why: ['This basket had no buy.'] };
  const why: string[] = [];
  for (const l of b.basket) {
    const leg = fresh.find((f) => f.symbol === l.symbol);
    if (AUTO_PICK_HOLD[l.symbol]) why.push(`${l.symbol}: a new listing, not offered from an agent’s link.`);
    else if (!leg) why.push(`${l.symbol}: no fresh price to check it against.`);
    else if (leg.verdict !== 'buy') why.push(`${l.symbol}: ${leg.decidedBy ?? leg.reasons[0] ?? 'it no longer passes the checks.'}`);
    else if (leg.cutBy) why.push(`${l.symbol}: its full share no longer fits ${leg.cutBy === 'cost limit' ? 'your cost limit' : 'the swap caps'}.`);
  }
  return why.length ? { ok: false, why } : { ok: true, usd: Math.floor(b.investedUsd * 100) / 100 };
}

export const planLinkPath = (id: string) => `/plan/${id}`;
