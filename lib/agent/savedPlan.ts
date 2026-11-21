// The store behind afterbook.app/plan/<id> (lib/agent/planLink.ts): one Redis key per agent plan, written
// once by the x402 plan and basket routes and the MCP plan tools, kept 7 days. The page reads it through
// Next's data cache (a saved plan never changes), so views don't each cost a Redis request.
import 'server-only';
import { randomBytes } from 'node:crypto';
import { unstable_cache } from 'next/cache';
import { redis } from '../server/redis';
import { isSavedPlan, PLAN_ID_RE, PLAN_LINK_TTL_S, type PlanLinkVia, type SavedPlan } from './planLink';
import type { Plan, PlanInput } from './plan';
import type { Brief } from './brief';

const KEY = (id: string) => `agentplan:${id}`;

/** Distributes Omit over the union, so each kind keeps its own fields. */
type Unsaved<T> = T extends SavedPlan ? Omit<T, 'v' | 'id' | 'at'> : never;

/** Saves the plan and returns its id, or null when it couldn't be saved (no Redis, or a write error):
 *  the caller still answers, without a link. */
export async function savePlan(p: Unsaved<SavedPlan>, now = Date.now()): Promise<string | null> {
  if (!redis) return null;
  const id = randomBytes(12).toString('base64url');
  const record = { ...p, v: 1, id, at: now } as SavedPlan;
  try {
    await redis.set(KEY(id), JSON.stringify(record), { ex: PLAN_LINK_TTL_S });
    return id;
  } catch (err) {
    console.error('saved plan: could not save', err instanceof Error ? err.message : err);
    return null;
  }
}

async function readUncached(id: string): Promise<SavedPlan | null> {
  if (!redis || !PLAN_ID_RE.test(id)) return null;
  const raw = await redis.get<unknown>(KEY(id));
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return isSavedPlan(value) && value.id === id ? value : null;
}

/** null: unknown, expired or unreadable. A read error throws (the page says to try again). */
export async function readSavedPlan(id: string): Promise<SavedPlan | null> {
  if (!PLAN_ID_RE.test(id)) return null;
  // An hour in the data cache; the plan is immutable, and a link that expires inside that hour still
  // shows (its recheck is fresh either way).
  return unstable_cache(() => readUncached(id), ['agentplan', id], { revalidate: 3600 })();
}

/** A stock plan's link, saved only when the plan has a buy. */
export async function saveStockPlan(
  input: PlanInput,
  out: { plan: Plan; explanation: string; explainedBy: 'claude' | 'fixed' },
  via: PlanLinkVia,
): Promise<string | null> {
  if (!out.plan.legs.some((l) => l.verdict === 'buy')) return null;
  const { note: _note, ...limits } = input;
  return savePlan({ kind: 'plan', via, input: limits, plan: out.plan, explanation: out.explanation, explainedBy: out.explainedBy });
}

/** A basket's link, saved only when there is a basket. */
export async function saveBasket(out: { brief: Brief; explanation: string; explainedBy: 'claude' | 'fixed' }, via: PlanLinkVia): Promise<string | null> {
  if (!out.brief.basket) return null;
  return savePlan({ kind: 'basket', via, brief: out.brief, explanation: out.explanation, explainedBy: out.explainedBy });
}
