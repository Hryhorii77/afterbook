// Personal stock rules (/rules, owner 2026-11-11): "buy $50 of NVDA every Monday, at most 0.5% over the
// real stock, pause near earnings". A rule never buys by itself. When a run is due, the page asks the
// server to check it with the trade plan's own code (lib/agent/plan.ts screen + sizeLegs, via
// /api/agent/rule-check), and a run that passes opens the normal swap panel for the person to sign.
//
// Rules and their history live only in the person's browser (localStorage, owner choice): nothing about
// them reaches the server except one check's inputs. Export/import moves them between browsers.
//
// Pure and browser-safe: no server imports. Dates are calendar days ('YYYY-MM-DD') in the person's own
// time zone; the page passes in today's key, so the maths here never reads the clock.

export const RULE_LIMITS = {
  maxRules: 12,
  /** Runs kept in the history (newest first). A live rule's bought and pending runs are never trimmed:
   *  its total cap is counted from them. */
  maxRuns: 200,
  minRunUsd: 10,
  /** Same as one swap's cap, MAX_SWAP_USD in lib/swap/swap.ts (a test keeps them equal). */
  maxRunUsd: 25_000,
  maxCapUsd: 1_000_000,
  /** Same bounds as the trade plan's form (lib/agent/limits.ts). */
  maxPremiumBp: 500,
  maxCostBp: 200,
  maxEarningsDays: 14,
  maxMonthDay: 28,
} as const;

export type Cadence =
  | { kind: 'weekly'; weekday: number }
  | { kind: 'biweekly'; weekday: number }
  | { kind: 'monthly'; day: number };

export interface Rule {
  id: string;
  symbol: string;
  /** USDC per run. */
  usd: number;
  cadence: Cadence;
  /** Stop once this much has been bought in total (null: no total cap). */
  capUsd: number | null;
  maxPremiumBp: number;
  maxCostBp: number;
  /** Pause a run if the company reports earnings within this many days (0: ignore earnings). */
  earningsDays: number;
  paused: boolean;
  /** The calendar day the rule was made; no run is due before it. */
  startKey: string;
  createdAt: number;
}

/** 'pending': the wallet sent the swap but this page hasn't seen it mined (saved before the receipt, so a
 *  closed tab can't make the run look due again and invite a second buy). The page settles it from the
 *  receipt on its next visit. */
export type RunOutcome = 'bought' | 'pending' | 'skipped';

export interface RuleRun {
  ruleId: string;
  symbol: string;
  /** The scheduled day this run belongs to. One outcome per rule and day. */
  slot: string;
  at: number;
  outcome: RunOutcome;
  /** Bought or pending: the exact USDC reviewed. */
  usd?: number;
  hash?: string;
  /** Pending: the sender and nonce once the node has seen the transaction. When the sender's count passes
   *  this nonce with no receipt for the hash, another transaction took the nonce and this one can never be
   *  mined. */
  from?: string;
  nonce?: number;
  /** Skipped: why, in the page's words (the check's deciding reason, or "You skipped it"). */
  reason?: string;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ---- calendar keys ----------------------------------------------------------------------------------

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isDayKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_RE.test(v) && keyOf(dayMs(v)) === v;
}
/** A day key as UTC midnight milliseconds (only for arithmetic between keys). */
const dayMs = (key: string) => Date.parse(`${key}T00:00:00Z`);
const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (key: string, n: number) => keyOf(dayMs(key) + n * DAY_MS);
const weekday = (key: string) => new Date(dayMs(key)).getUTCDay();

/** Today's key in the browser's own time zone. */
export function localDayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- the schedule ----------------------------------------------------------------------------------

/** The most recent scheduled day on or before `today`, or null if the rule has none yet. */
export function latestSlot(rule: Pick<Rule, 'cadence' | 'startKey'>, today: string): string | null {
  const c = rule.cadence;
  let slot: string | null;
  if (c.kind === 'weekly') {
    slot = addDays(today, -((weekday(today) - c.weekday + 7) % 7));
  } else if (c.kind === 'biweekly') {
    // Every other week, counted from the first matching weekday on or after the start.
    const anchor = addDays(rule.startKey, (c.weekday - weekday(rule.startKey) + 7) % 7);
    if (today < anchor) return null;
    const weeks = Math.floor((dayMs(today) - dayMs(anchor)) / DAY_MS / 14);
    slot = addDays(anchor, weeks * 14);
  } else {
    const [y, m, d] = today.split('-').map(Number);
    const ym = d >= c.day ? [y, m] : m === 1 ? [y - 1, 12] : [y, m - 1];
    slot = `${ym[0]}-${String(ym[1]).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
  }
  return slot < rule.startKey ? null : slot;
}

/** The next scheduled day strictly after `today`. */
export function nextSlot(rule: Pick<Rule, 'cadence' | 'startKey'>, today: string): string {
  for (let i = 1; i <= 62; i++) {
    const day = addDays(today, i);
    if (latestSlot(rule, day) === day) return day;
  }
  return addDays(today, 62); // unreachable for valid cadences
}

/** USDC spent so far under a rule; a pending buy counts until it is known to have failed. */
export function spentUsd(ruleId: string, runs: RuleRun[]): number {
  return runs.reduce((s, r) => s + (r.ruleId === ruleId && r.outcome !== 'skipped' ? (r.usd ?? 0) : 0), 0);
}

/** What a run may spend: the rule's amount, cut to what's left of its total cap. Below the minimum swap
 *  the rule is finished (0). */
export function runBudget(rule: Pick<Rule, 'id' | 'usd' | 'capUsd'>, runs: RuleRun[]): number {
  const left = rule.capUsd == null ? rule.usd : Math.min(rule.usd, rule.capUsd - spentUsd(rule.id, runs));
  return left >= RULE_LIMITS.minRunUsd ? Math.floor(left * 100) / 100 : 0;
}

export type RuleState =
  | { kind: 'due'; slot: string; usd: number }
  | { kind: 'done-today'; slot: string; outcome: RunOutcome; next: string }
  | { kind: 'waiting'; next: string }
  | { kind: 'paused' }
  | { kind: 'finished' };

/** Where a rule stands today. A missed run is still due until the next scheduled day replaces it; runs
 *  never pile up (at most one is due per rule). */
export function ruleState(rule: Rule, runs: RuleRun[], today: string): RuleState {
  const budget = runBudget(rule, runs);
  if (budget === 0) return { kind: 'finished' };
  if (rule.paused) return { kind: 'paused' };
  const slot = latestSlot(rule, today);
  const next = nextSlot(rule, today);
  if (!slot) return { kind: 'waiting', next };
  const handled = runs.find((r) => r.ruleId === rule.id && r.slot === slot);
  if (handled) return { kind: 'done-today', slot, outcome: handled.outcome, next };
  return { kind: 'due', slot, usd: budget };
}

export function cadenceText(c: Cadence): string {
  if (c.kind === 'weekly') return `Every ${WEEKDAYS[c.weekday]}`;
  if (c.kind === 'biweekly') return `Every other ${WEEKDAYS[c.weekday]}`;
  const n = c.day;
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';
  return `Monthly on the ${n}${suffix}`;
}

/** "Mon 16 Nov" for a day key (no time zone shift: the key is already local). */
export function dayText(key: string): string {
  const d = new Date(dayMs(key));
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---- validation (storage and imports are the visitor's to edit) ---------------------------------------

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isInt = (v: unknown, lo: number, hi: number): v is number => isNum(v, lo, hi) && Number.isInteger(v);
const ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

export function isCadence(v: unknown): v is Cadence {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (c.kind === 'weekly' || c.kind === 'biweekly') return isInt(c.weekday, 0, 6);
  if (c.kind === 'monthly') return isInt(c.day, 1, RULE_LIMITS.maxMonthDay);
  return false;
}

/** One stored or imported rule, checked field by field. `known` says whether a symbol is a tracked stock. */
export function isRule(v: unknown, known: (symbol: string) => boolean): v is Rule {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' && ID_RE.test(r.id) &&
    typeof r.symbol === 'string' && known(r.symbol) &&
    isNum(r.usd, RULE_LIMITS.minRunUsd, RULE_LIMITS.maxRunUsd) &&
    isCadence(r.cadence) &&
    (r.capUsd === null || isNum(r.capUsd, RULE_LIMITS.minRunUsd, RULE_LIMITS.maxCapUsd)) &&
    isNum(r.maxPremiumBp, 0, RULE_LIMITS.maxPremiumBp) &&
    isNum(r.maxCostBp, 1, RULE_LIMITS.maxCostBp) &&
    isInt(r.earningsDays, 0, RULE_LIMITS.maxEarningsDays) &&
    typeof r.paused === 'boolean' &&
    isDayKey(r.startKey) &&
    isNum(r.createdAt, 0, Number.MAX_SAFE_INTEGER)
  );
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isRuleRun(v: unknown): v is RuleRun {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.ruleId === 'string' && ID_RE.test(r.ruleId) &&
    typeof r.symbol === 'string' && r.symbol.length <= 20 &&
    isDayKey(r.slot) &&
    isNum(r.at, 0, Number.MAX_SAFE_INTEGER) &&
    (r.outcome === 'bought' || r.outcome === 'pending' || r.outcome === 'skipped') &&
    (r.usd === undefined || isNum(r.usd, 0, RULE_LIMITS.maxRunUsd)) &&
    (r.hash === undefined || (typeof r.hash === 'string' && HASH_RE.test(r.hash))) &&
    (r.from === undefined || (typeof r.from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(r.from))) &&
    (r.nonce === undefined || isInt(r.nonce, 0, Number.MAX_SAFE_INTEGER)) &&
    (r.reason === undefined || (typeof r.reason === 'string' && r.reason.length <= 400))
  );
}

/** Keeps the good entries: rules by distinct id (at most maxRules). */
export function cleanRules(rules: unknown, known: (symbol: string) => boolean): Rule[] {
  if (!Array.isArray(rules)) return [];
  const seen = new Set<string>();
  return rules
    .filter((r): r is Rule => isRule(r, known) && !seen.has(r.id) && !!seen.add(r.id))
    .slice(0, RULE_LIMITS.maxRules)
    .map(pickRule);
}

/** Rebuilt from the known fields only, so nothing extra from storage or an import file rides along. */
function pickRule(r: Rule): Rule {
  const cadence: Cadence = r.cadence.kind === 'monthly' ? { kind: 'monthly', day: r.cadence.day } : { kind: r.cadence.kind, weekday: r.cadence.weekday };
  return {
    id: r.id, symbol: r.symbol, usd: r.usd, cadence, capUsd: r.capUsd, maxPremiumBp: r.maxPremiumBp, maxCostBp: r.maxCostBp,
    earningsDays: r.earningsDays, paused: r.paused, startKey: r.startKey, createdAt: r.createdAt,
  };
}
function pickRun(r: RuleRun): RuleRun {
  const out: RuleRun = { ruleId: r.ruleId, symbol: r.symbol, slot: r.slot, at: r.at, outcome: r.outcome };
  if (r.usd !== undefined) out.usd = r.usd;
  if (r.hash !== undefined) out.hash = r.hash;
  if (r.reason !== undefined) out.reason = r.reason;
  if (r.from !== undefined) out.from = r.from;
  if (r.nonce !== undefined) out.nonce = r.nonce;
  return out;
}
const RANK: Record<RunOutcome, number> = { bought: 0, pending: 1, skipped: 2 };

/** Keeps the good runs, one per rule and day (a buy wins over a pending one, which wins over a skip; then
 *  the newest), newest first. The history is trimmed to maxRuns, except the bought and pending runs of
 *  the rules in `live`: a rule's total cap is counted from them, so dropping one would let it buy again. */
export function cleanRuns(runs: unknown, live: ReadonlySet<string> = new Set()): RuleRun[] {
  if (!Array.isArray(runs)) return [];
  const best = new Map<string, RuleRun>();
  for (const raw of runs) {
    if (!isRuleRun(raw)) continue;
    const r = pickRun(raw);
    const key = `${r.ruleId}|${r.slot}`;
    const had = best.get(key);
    if (!had || RANK[r.outcome] < RANK[had.outcome] || (RANK[r.outcome] === RANK[had.outcome] && r.at > had.at)) best.set(key, r);
  }
  const sorted = [...best.values()].sort((a, b) => b.at - a.at);
  const kept = (r: RuleRun) => live.has(r.ruleId) && r.outcome !== 'skipped';
  let room = Math.max(0, RULE_LIMITS.maxRuns - sorted.filter(kept).length);
  return sorted.filter((r) => kept(r) || (room-- > 0));
}

// ---- export / import ---------------------------------------------------------------------------------

export const EXPORT_APP = 'afterbook-rules';

export interface RulesFile {
  app: typeof EXPORT_APP;
  version: 1;
  exportedAt: number;
  rules: Rule[];
  runs: RuleRun[];
}

export function exportFile(rules: Rule[], runs: RuleRun[], now: number): RulesFile {
  return { app: EXPORT_APP, version: 1, exportedAt: now, rules, runs };
}

/** Reads an exported file and merges it into what this browser has: an imported rule replaces the one
 *  with the same id, history merges one run per rule and day. Returns a message for a file it can't use. */
export function importFile(
  text: string,
  current: { rules: Rule[]; runs: RuleRun[] },
  known: (symbol: string) => boolean,
): { rules: Rule[]; runs: RuleRun[]; added: number; skipped: number } | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return 'That file isn’t a rules export (it isn’t JSON).';
  }
  if (!data || typeof data !== 'object' || (data as Record<string, unknown>).app !== EXPORT_APP) return 'That file isn’t an Afterbook rules export.';
  const f = data as Record<string, unknown>;
  if (f.version !== 1) return 'That export is from a newer version of the page. Reload and try again.';
  const raw = Array.isArray(f.rules) ? f.rules : [];
  const incoming = cleanRules(raw, known);
  const ids = new Set(incoming.map((r) => r.id));
  const rules = [...incoming, ...current.rules.filter((r) => !ids.has(r.id))];
  if (rules.length > RULE_LIMITS.maxRules) return `That would make ${rules.length} rules; the most is ${RULE_LIMITS.maxRules}. Delete some first.`;
  const runs = cleanRuns([...(Array.isArray(f.runs) ? f.runs : []), ...current.runs], new Set(rules.map((r) => r.id)));
  return { rules, runs, added: incoming.length, skipped: raw.length - incoming.length };
}
