// What a stock token's multiplier change means (lib/stocks/multiplierHistory.ts reads them onchain).
// Pure and browser-safe: the stock pages use it to word each entry.

export interface CorporateAction {
  symbol: string;
  /** Block number, as a string (JSON in Redis). */
  block: string;
  tx: `0x${string}`;
  logIndex: number;
  atMs: number;
  /** multiplier() one block before, 1e18 = 1.0x; null if that read failed. */
  fromRaw: string | null;
  toRaw: string;
}

export type ActionKind = 'dividend' | 'split' | 'reverse-split' | 'other';

export interface ClassifiedAction {
  kind: ActionKind;
  from: number | null;
  to: number;
  /** Change in percent (to/from − 1), for a dividend; null otherwise. */
  pct: number | null;
  /** "4-for-1", "1-for-10"; null unless a split. */
  ratio: string | null;
}

const ONE = 1e18;

/**
 * A rise under 20% is a reinvested dividend (a quarterly dividend is well under 1%); a whole-number
 * ratio of 2 or more (or its inverse) is a split (or a reverse split); anything else is just "changed".
 */
export function classifyAction(a: Pick<CorporateAction, 'fromRaw' | 'toRaw'>): ClassifiedAction {
  const to = Number(BigInt(a.toRaw)) / ONE;
  const from = a.fromRaw != null ? Number(BigInt(a.fromRaw)) / ONE : null;
  if (from == null || !(from > 0)) return { kind: 'other', from, to, pct: null, ratio: null };
  const r = to / from;
  const near = (x: number) => Math.abs(x - Math.round(x)) < 0.001 * x;
  if (r >= 2 && near(r)) return { kind: 'split', from, to, pct: null, ratio: `${Math.round(r)}-for-1` };
  if (r > 0 && r <= 0.5 && near(1 / r)) return { kind: 'reverse-split', from, to, pct: null, ratio: `1-for-${Math.round(1 / r)}` };
  if (r > 1 && r < 1.2) return { kind: 'dividend', from, to, pct: (r - 1) * 100, ratio: null };
  return { kind: 'other', from, to, pct: null, ratio: null };
}
