// Paid x402 calls (2026-11-25, for /traction): every payment Coinbase's facilitator settles for one of the paid
// routes is recorded once, keyed by its settlement transaction, so the count is backed by real onchain payments.
// One Redis write per paid call (rare), read through the traction page's hourly data cache. Recording never fails
// a paid answer: a store error is logged and the call is just not counted.
import { redis } from './redis';
import { X402_DISCOVERY, type X402Route } from './x402Discovery';

const KEY = 'x402:paid';
const DAY = 86_400_000;

export interface PaidCall {
  tx: string;
  route: X402Route | 'other';
  /** USDC paid, in raw units (6 decimals). */
  amount: string;
  payer: string | null;
  at: number;
}

/** The paid route from a resource URL ("https://afterbook.app/api/v1/x402/plan?…" → "plan"). */
export function routeOf(resourceUrl: string | undefined): PaidCall['route'] {
  if (!resourceUrl) return 'other';
  let path: string;
  try {
    path = new URL(resourceUrl, 'https://afterbook.app').pathname;
  } catch {
    return 'other';
  }
  const name = path.replace(/\/+$/, '').split('/api/v1/x402/')[1];
  return name && name in X402_DISCOVERY ? (name as X402Route) : 'other';
}

export async function recordPaidCall(call: PaidCall): Promise<void> {
  if (!redis || !/^0x[0-9a-fA-F]{64}$/.test(call.tx)) return;
  try {
    // HSETNX: the same settlement reported twice is one call.
    await redis.hsetnx(KEY, call.tx.toLowerCase(), JSON.stringify(call));
  } catch (err) {
    console.error('[x402 ledger] record failed', err instanceof Error ? err.message : err);
  }
}

export async function paidCalls(): Promise<PaidCall[] | null> {
  if (!redis) return null;
  const raw = await redis.hgetall<Record<string, unknown>>(KEY);
  return Object.values(raw ?? {}).flatMap((v) => {
    try {
      const c = (typeof v === 'string' ? JSON.parse(v) : v) as PaidCall;
      return c && typeof c.tx === 'string' && typeof c.at === 'number' ? [c] : [];
    } catch {
      return [];
    }
  });
}

export interface PaidCallStats {
  calls: number;
  /** USDC paid in all. */
  usdc: number;
  byRoute: Partial<Record<PaidCall['route'], { calls: number; usdc: number }>>;
}

/** Totals for the calls since `since` (all of them when omitted). Pure. */
export function summarizePaidCalls(calls: PaidCall[], since = 0): PaidCallStats {
  const out: PaidCallStats = { calls: 0, usdc: 0, byRoute: {} };
  for (const c of calls) {
    if (c.at < since) continue;
    const usdc = Number(c.amount) / 1e6;
    if (!Number.isFinite(usdc)) continue;
    out.calls += 1;
    out.usdc += usdc;
    const r = (out.byRoute[c.route] ??= { calls: 0, usdc: 0 });
    r.calls += 1;
    r.usdc += usdc;
  }
  return out;
}

export const last30Days = (now: number) => now - 30 * DAY;

/** What the x402 server's after-settle hook hands over (the fields this ledger reads). */
export interface SettlementLike {
  result: { success: boolean; transaction?: string; amount?: string; payer?: string };
  requirements: { amount: string };
  paymentPayload: { resource?: { url?: string } };
}

/** The x402 server's after-settle hook: records a successful settlement once; skips a failed one. Never throws:
 *  an error here must not fail a call that was already paid (and x402 fails a paid answer whose hook throws an
 *  AfterSettleAbortError, so nothing is allowed to escape). */
export async function recordSettlement(ctx: SettlementLike, now = Date.now()): Promise<void> {
  try {
    if (!ctx.result.success || !ctx.result.transaction) return;
    await recordPaidCall({
      tx: ctx.result.transaction,
      route: routeOf(ctx.paymentPayload.resource?.url),
      amount: ctx.result.amount ?? ctx.requirements.amount,
      payer: ctx.result.payer ?? null,
      at: now,
    });
  } catch (err) {
    console.error('[x402] after-settle record failed', err instanceof Error ? err.message : err);
  }
}
