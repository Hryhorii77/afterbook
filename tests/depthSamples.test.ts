import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ kv: new Map<string, unknown>(), sets: [] as { key: string; ex?: number }[], gets: 0 }));
vi.mock('../lib/server/redis', () => ({
  redis: {
    set: async (key: string, value: unknown, opts?: { ex?: number }) => {
      store.sets.push({ key, ex: opts?.ex });
      store.kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    mget: async (...keys: string[]) => {
      store.gets++;
      return keys.map((k) => store.kv.get(k) ?? null);
    },
  },
}));

import { DEPTH_SLOT_MS, getRecentDepthSamples, recordDepthSample, sampleFromRows, steadyDepth, type DepthSample } from '../lib/market/depthSamples';

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const at = (minsAgo: number, d: Record<string, number | null>): DepthSample => ({ ts: NOW - minsAgo * MIN, d });

describe('sampleFromRows', () => {
  it('keeps a failed or nonsense read as null, never $0', () => {
    const s = sampleFromRows(
      [
        { symbol: 'NVDAc', depthUsd: 1_234_567.8 },
        { symbol: 'HIMSc', depthUsd: null },
        { symbol: 'LLYc', depthUsd: Number.NaN },
        { symbol: 'AAPLc', depthUsd: -5 },
      ],
      NOW,
    );
    expect(s).toEqual({ ts: NOW, d: { NVDAc: 1_234_568, HIMSc: null, LLYc: null, AAPLc: null } });
  });
});

describe('steadyDepth', () => {
  it('is the lowest good sample in the last 3 hours, with the newest sample time', () => {
    const samples = [at(200, { X: 10 }), at(170, { X: 49_000 }), at(60, { X: 254_000 }), at(5, { X: 260_000 })];
    expect(steadyDepth(samples, 'X', NOW)).toEqual({ usd: 49_000, asOfMs: NOW - 5 * MIN, samples: 3 });
  });
  it('a failed read is a missing sample, not a low one', () => {
    const samples = [at(20, { X: 300_000 }), at(10, { X: null }), at(5, { X: 310_000 })];
    expect(steadyDepth(samples, 'X', NOW).usd).toBe(300_000);
  });
  it('unknown when no good sample in the last 15 minutes: cold start or a stopped cron', () => {
    expect(steadyDepth([], 'X', NOW)).toEqual({ usd: null, asOfMs: null, samples: 0 });
    expect(steadyDepth([at(16, { X: 500_000 })], 'X', NOW).usd).toBeNull();
    expect(steadyDepth([at(16, { X: 500_000 }), at(3, { X: null })], 'X', NOW).usd).toBeNull();
    expect(steadyDepth([at(3, { Y: 500_000 })], 'X', NOW).usd).toBeNull();
  });
  it('never falls back to a live read, which can only lower it', () => {
    expect(steadyDepth([], 'X', NOW, 900_000).usd).toBeNull();
    expect(steadyDepth([at(3, { X: 300_000 })], 'X', NOW, 900_000).usd).toBe(300_000);
    expect(steadyDepth([at(3, { X: 300_000 })], 'X', NOW, 120_000).usd).toBe(120_000);
  });
  it('ignores samples from the future', () => {
    expect(steadyDepth([at(-10, { X: 1 }), at(2, { X: 400_000 })], 'X', NOW).usd).toBe(400_000);
  });
});

describe('recording and reading', () => {
  it('one key per run with a 4-hour expiry, read back in one MGET, cached for a minute', async () => {
    const rows = [
      { symbol: 'NVDAc', depthUsd: 1_000_000 },
      { symbol: 'HIMSc', depthUsd: null },
    ];
    for (let i = 4; i >= 0; i--) await recordDepthSample(rows, NOW - i * DEPTH_SLOT_MS);
    expect(store.sets).toHaveLength(5);
    expect(new Set(store.sets.map((s) => s.key)).size).toBe(5);
    expect(store.sets.every((s) => s.ex === 4 * 3600)).toBe(true);

    const samples = await getRecentDepthSamples(NOW);
    expect(samples).toHaveLength(5);
    expect(store.gets).toBe(1);
    expect(steadyDepth(samples, 'NVDAc', NOW).usd).toBe(1_000_000);
    expect(steadyDepth(samples, 'HIMSc', NOW).usd).toBeNull();
    await getRecentDepthSamples(NOW + 30_000);
    expect(store.gets).toBe(1);
  });
});
