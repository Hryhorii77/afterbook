import { redis } from '../redis';
import { STOCKS } from '../tokens';
import { getStrategy, publishStrategyVersion } from '../glider';
import type { TapeResult } from '../tape';
import { buildTilt, assetIdFor } from './tilt';
import { smoothWeights, type SmoothResult } from './weights';

const emaKey = (strategyId: string) => `basket:ema:${strategyId}`;

export interface TiltPlan extends SmoothResult {
  strategyId: string;
  version: number | null;
  /** Set when the run must not publish regardless of turnover. */
  blocked: string | null;
}

/** Reads the live strategy and the stored moving average, and decides what
 *  (if anything) to publish. Pure planning — publishes and writes nothing. */
export async function planTiltUpdate(strategyId: string, tape: TapeResult): Promise<TiltPlan> {
  const target = buildTilt(tape);
  const strategy = await getStrategy(strategyId);

  const bySymbol = new Map(STOCKS.map((s) => [assetIdFor(s.symbol).toLowerCase(), s.symbol]));
  const published: Record<string, number> = {};
  let unknownAsset: string | null = null;
  for (const a of strategy.allocation.assets) {
    const symbol = bySymbol.get(a.assetId.toLowerCase());
    if (!symbol) unknownAsset = a.assetId;
    else published[symbol] = Number(a.weight) / 100;
  }

  // Never rewrite a strategy whose asset list isn't exactly the tracked set
  // (e.g. a 3-token test strategy, or one someone edited by hand): publishing
  // would silently change what every enrolled user holds.
  const sameSet =
    !unknownAsset && Object.keys(published).length === target.length && target.every((t) => t.symbol in published);

  const ema = redis ? await redis.get<Record<string, number>>(emaKey(strategyId)).catch(() => null) : null;
  const result = smoothWeights({ target, ema, published: sameSet ? published : null });

  return {
    ...result,
    strategyId,
    version: strategy.version,
    blocked: sameSet ? null : 'strategy asset list does not match the tracked stocks — refusing to publish',
  };
}

/** Persists the moving average and, only if the plan says so, publishes a new
 *  strategy version (live for every enrolled portfolio on its next run). */
export async function applyTiltUpdate(plan: TiltPlan): Promise<{ published: boolean; version?: number }> {
  if (redis) await redis.set(emaKey(plan.strategyId), plan.ema).catch(() => {});
  if (plan.blocked || !plan.publish) return { published: false };
  const allocation = {
    assets: plan.weights.map((w) => ({ assetId: assetIdFor(w.symbol), weight: w.weight })),
  };
  const out = await publishStrategyVersion(plan.strategyId, allocation, `auto: ${plan.reason}`.slice(0, 500));
  return { published: true, version: out.version };
}
