import { describe, expect, it } from 'vitest';
import {
  RULE_LIMITS,
  cadenceText,
  cleanRuns,
  exportFile,
  importFile,
  isDayKey,
  isRule,
  latestSlot,
  nextSlot,
  ruleState,
  runBudget,
  type Rule,
  type RuleRun,
} from '../lib/agent/rules';
import { MAX_SWAP_USD } from '../lib/swap/swap';

const known = (s: string) => s === 'NVDAc' || s === 'METAc';
// 2026-11-11 is a Wednesday.
const base: Rule = {
  id: 'rule_1',
  symbol: 'NVDAc',
  usd: 50,
  cadence: { kind: 'weekly', weekday: 1 },
  capUsd: null,
  maxPremiumBp: 50,
  maxCostBp: 30,
  earningsDays: 2,
  paused: false,
  startKey: '2026-11-11',
  createdAt: 1,
};
const run = (p: Partial<RuleRun>): RuleRun => ({ ruleId: 'rule_1', symbol: 'NVDAc', slot: '2026-11-16', at: 2, outcome: 'bought', usd: 50, ...p });

describe('rule schedule', () => {
  it('weekly: due on its weekday, never before the rule was made', () => {
    expect(latestSlot(base, '2026-11-15')).toBeNull(); // last Monday (Nov 9) is before the start
    expect(latestSlot(base, '2026-11-16')).toBe('2026-11-16');
    expect(latestSlot(base, '2026-11-19')).toBe('2026-11-16'); // missed: still the same run
    expect(latestSlot(base, '2026-11-23')).toBe('2026-11-23'); // replaced, not stacked
    expect(nextSlot(base, '2026-11-11')).toBe('2026-11-16');
    expect(latestSlot({ ...base, cadence: { kind: 'weekly', weekday: 3 } }, '2026-11-11')).toBe('2026-11-11'); // made on its day: due today
  });
  it('every other week counts from the first matching day', () => {
    const r = { ...base, cadence: { kind: 'biweekly', weekday: 1 } as const };
    expect(latestSlot(r, '2026-11-16')).toBe('2026-11-16');
    expect(latestSlot(r, '2026-11-23')).toBe('2026-11-16');
    expect(latestSlot(r, '2026-11-30')).toBe('2026-11-30');
    expect(nextSlot(r, '2026-11-16')).toBe('2026-11-30');
  });
  it('monthly, across a year end', () => {
    const r = { ...base, cadence: { kind: 'monthly', day: 5 } as const, startKey: '2026-12-01' };
    expect(latestSlot(r, '2026-12-04')).toBeNull();
    expect(latestSlot(r, '2026-12-05')).toBe('2026-12-05');
    expect(latestSlot(r, '2027-01-04')).toBe('2026-12-05');
    expect(nextSlot(r, '2026-12-31')).toBe('2027-01-05');
    expect(latestSlot({ ...r, startKey: '2026-01-01' }, '2026-01-03')).toBeNull();
    expect(latestSlot({ ...r, startKey: '2025-12-01' }, '2026-01-03')).toBe('2025-12-05');
  });
  it('states: due, done, paused, finished at the cap', () => {
    expect(ruleState(base, [], '2026-11-12')).toEqual({ kind: 'waiting', next: '2026-11-16' });
    expect(ruleState(base, [], '2026-11-17')).toEqual({ kind: 'due', slot: '2026-11-16', usd: 50 });
    expect(ruleState(base, [run({ outcome: 'skipped', usd: undefined })], '2026-11-17')).toMatchObject({ kind: 'done-today', outcome: 'skipped', next: '2026-11-23' });
    expect(ruleState({ ...base, paused: true }, [], '2026-11-17')).toEqual({ kind: 'paused' });
    const capped = { ...base, capUsd: 120 };
    const runs = [run({}), run({ slot: '2026-11-23' })];
    expect(runBudget(capped, runs)).toBe(20); // the last run is cut to what's left
    expect(ruleState(capped, runs, '2026-11-30')).toEqual({ kind: 'due', slot: '2026-11-30', usd: 20 });
    expect(ruleState(capped, [...runs, run({ slot: '2026-11-30', usd: 15 })], '2026-12-07')).toEqual({ kind: 'finished' }); // $5 left: under a swap
  });
  it('words', () => {
    expect(cadenceText({ kind: 'weekly', weekday: 1 })).toBe('Every Monday');
    expect(cadenceText({ kind: 'biweekly', weekday: 5 })).toBe('Every other Friday');
    expect(cadenceText({ kind: 'monthly', day: 22 })).toBe('Monthly on the 22nd');
    expect(cadenceText({ kind: 'monthly', day: 11 })).toBe('Monthly on the 11th');
  });
});

describe('rule validation and backup', () => {
  it('a run is capped like one swap', () => {
    expect(RULE_LIMITS.maxRunUsd).toBe(MAX_SWAP_USD);
  });
  it('rejects bad or edited rules', () => {
    expect(isRule(base, known)).toBe(true);
    expect(isRule({ ...base, symbol: 'PEPE' }, known)).toBe(false);
    expect(isRule({ ...base, usd: 30_000 }, known)).toBe(false);
    expect(isRule({ ...base, cadence: { kind: 'monthly', day: 31 } }, known)).toBe(false);
    expect(isRule({ ...base, id: '<script>' }, known)).toBe(false);
    expect(isRule({ ...base, startKey: '2026-02-30' }, known)).toBe(false);
    expect(isDayKey('2026-11-11')).toBe(true);
  });
  it('keeps one run per rule and day, newest first, and drops bad hashes', () => {
    const runs = cleanRuns([run({ at: 1 }), run({ at: 5, usd: 80 }), run({ slot: '2026-11-23', hash: 'nope' as `0x${string}` })]);
    expect(runs).toHaveLength(1);
    expect(runs[0].usd).toBe(80);
  });
  it('a buy wins over a skip or a pending for the same run, whatever the order', () => {
    const runs = cleanRuns([run({ outcome: 'skipped', usd: undefined, at: 9 }), run({ outcome: 'pending', at: 8 }), run({ at: 1 })]);
    expect(runs).toHaveLength(1);
    expect(runs[0].outcome).toBe('bought');
  });
  it('a pending buy counts toward the cap and makes the run handled', () => {
    const capped = { ...base, capUsd: 60 };
    const pending = [run({ outcome: 'pending', usd: 50 })];
    expect(ruleState(capped, pending, '2026-11-17')).toMatchObject({ kind: 'done-today', outcome: 'pending' });
    expect(runBudget(capped, pending)).toBe(10);
  });
  it('never trims a live rule’s buys, so its cap can’t reset', () => {
    // 150 old buys of a capped rule and 300 newer skips of another rule: the buys all stay.
    const buys = Array.from({ length: 150 }, (_, i) => run({ slot: `2020-01-01`.replace('2020', String(2000 + Math.floor(i / 12))).replace('-01-01', `-${String((i % 12) + 1).padStart(2, '0')}-01`), at: i + 1, usd: 50 }));
    const skips = Array.from({ length: 300 }, (_, i) => ({ ruleId: 'rule_2', symbol: 'METAc', slot: `2030-01-${String((i % 28) + 1).padStart(2, '0')}`, at: 10_000 + i, outcome: 'skipped' as const, reason: `x${Math.floor(i / 28)}` }))
      .map((r, i) => ({ ...r, slot: `${2030 + Math.floor(i / 28)}-01-${String((i % 28) + 1).padStart(2, '0')}` }));
    const kept = cleanRuns([...buys, ...skips], new Set(['rule_1', 'rule_2']));
    expect(kept.filter((r) => r.ruleId === 'rule_1')).toHaveLength(150);
    expect(kept).toHaveLength(RULE_LIMITS.maxRuns);
    // Once the rule is deleted its buys may be trimmed like anything else.
    expect(cleanRuns([...buys, ...skips]).filter((r) => r.ruleId === 'rule_1')).toHaveLength(0);
  });
  it('round-trips an export and merges an import', () => {
    const file = JSON.stringify(exportFile([base], [run({})], 9));
    const other = { ...base, id: 'rule_2', symbol: 'METAc' };
    const res = importFile(file, { rules: [other], runs: [] }, known);
    expect(typeof res).not.toBe('string');
    if (typeof res === 'string') return;
    expect(res.rules.map((r) => r.id)).toEqual(['rule_1', 'rule_2']);
    expect(res.runs).toHaveLength(1);
    expect(res.added).toBe(1);
    const withBad = JSON.stringify({ ...exportFile([base, { ...base, id: 'rule_3', symbol: 'XYZc' }], [], 9) });
    const res2 = importFile(withBad, { rules: [], runs: [] }, known);
    expect(typeof res2 !== 'string' && res2.skipped).toBe(1);
  });
  it('rebuilds rules and runs from their known fields only', () => {
    const extra = { ...base, evil: '<img src=x>', cadence: { kind: 'weekly', weekday: 1, x: 1 } };
    const res = importFile(JSON.stringify({ app: 'afterbook-rules', version: 1, rules: [extra], runs: [{ ...run({}), junk: 1 }] }), { rules: [], runs: [] }, known);
    if (typeof res === 'string') throw new Error(res);
    expect(Object.keys(res.rules[0])).not.toContain('evil');
    expect(res.rules[0].cadence).toEqual({ kind: 'weekly', weekday: 1 });
    expect(Object.keys(res.runs[0])).not.toContain('junk');
  });
  it('refuses files that aren’t an export', () => {
    expect(importFile('not json', { rules: [], runs: [] }, known)).toMatch(/isn’t JSON/);
    expect(importFile('{"app":"other"}', { rules: [], runs: [] }, known)).toMatch(/isn’t an Afterbook rules export/);
    expect(importFile('{"app":"afterbook-rules","version":2}', { rules: [], runs: [] }, known)).toMatch(/newer version/);
    const many = Array.from({ length: 13 }, (_, i) => ({ ...base, id: `rule_x${i}` }));
    expect(importFile(JSON.stringify({ app: 'afterbook-rules', version: 1, rules: many, runs: [] }), { rules: [{ ...base, id: 'rule_y' }], runs: [] }, known)).toMatch(/the most is 12/);
  });
});
