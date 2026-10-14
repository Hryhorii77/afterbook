import { getStock } from './tokens';

// A basket someone builds on /build: 2–4 tracked stocks with
// whole-percent weights, carried entirely in the URL so every basket is a
// shareable link with its own card. Nothing here touches Glider or the
// Basis Tilt basket (lib/baskets/*). Buying one is lib/basketBuy.ts and
// BasketBuyPanel: plain KyberSwap swaps, one per stock, from the visitor's wallet.
//
// URL form: /build/NVDAc-40_AAPLc-30_METAc-30, or /build/NVDAc_AAPLc_METAc
// for equal weights. Symbols are case-insensitive; weights are normalized
// to sum to 100 so a hand-typed link never breaks.

export const MIN_LEGS = 2;
export const MAX_LEGS = 4;

export interface BasketLeg {
  symbol: string;
  /** Whole percent; all legs sum to 100. */
  weightPct: number;
}

/** Spread `total` over integer parts in proportion to `raw`, largest remainder first. */
function apportion(raw: number[], total: number): number[] {
  const sum = raw.reduce((a, b) => a + b, 0);
  const exact = raw.map((r) => (r / sum) * total);
  const out = exact.map(Math.floor);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < total - out.reduce((a, b) => a + b, 0); k++) out[order[k][1]]++;
  return out;
}

export function normalizeLegs(legs: { symbol: string; weight: number }[]): BasketLeg[] {
  const weights = legs.map((l) => (Number.isFinite(l.weight) && l.weight > 0 ? l.weight : 0));
  const usable = weights.some((w) => w > 0) ? weights : legs.map(() => 1);
  const pcts = apportion(usable, 100);
  return legs.map((l, i) => ({ symbol: l.symbol, weightPct: pcts[i] })).filter((l) => l.weightPct > 0);
}

export function parseSpec(spec: string): BasketLeg[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(spec);
  } catch {
    return null; // a malformed escape (/build/%E0%A4) is a 404, not a crash
  }
  const parts = decoded.split('_').filter(Boolean);
  if (parts.length < MIN_LEGS || parts.length > MAX_LEGS) return null;
  const legs: { symbol: string; weight: number }[] = [];
  for (const part of parts) {
    const [sym, w] = part.split('-');
    const stock = getStock(sym ?? '');
    if (!stock || legs.some((l) => l.symbol === stock.symbol)) return null;
    legs.push({ symbol: stock.symbol, weight: w == null ? 1 : Number(w) });
  }
  const normalized = normalizeLegs(legs);
  return normalized.length >= MIN_LEGS ? normalized : null;
}

export function formatSpec(legs: BasketLeg[]): string {
  const equal = legs.every((l) => Math.abs(l.weightPct - legs[0].weightPct) <= 1);
  return legs.map((l) => (equal ? l.symbol : `${l.symbol}-${l.weightPct}`)).join('_');
}

export const basketLabel = (legs: BasketLeg[]) => legs.map((l) => `${l.symbol} ${l.weightPct}%`).join(' · ');

export interface LegGapInput {
  symbol: string;
  onchainMidUsd: number | null;
  closeUsd: number | null;
  closeAsOfMs: number | null;
  basisBp: number | null;
  cashPriceType: 'regular' | 'pre-market' | 'after-hours';
}

/**
 * One leg's gap, by the home page hero's rule (HomeClient heroBp): while the
 * cash market is fully closed (overnight, weekend, holiday) it is measured
 * against the last regular-session close; otherwise it is the row's basisBp,
 * which during pre-market/after-hours is against a live extended-hours
 * print when Yahoo has one and against the close when it doesn't.
 */
export function legGapBp(row: LegGapInput, sessionState: string): number | null {
  if (sessionState.startsWith('closed')) {
    return row.closeUsd != null && row.onchainMidUsd != null ? ((row.onchainMidUsd - row.closeUsd) / row.closeUsd) * 10_000 : null;
  }
  return row.basisBp;
}

/** Weighted average of the legs' gaps. null if any leg has no reading: a
 *  partial average would quietly describe a different basket. */
export function basketGapBp(legs: BasketLeg[], rows: LegGapInput[], sessionState: string): number | null {
  let total = 0;
  for (const leg of legs) {
    const row = rows.find((r) => r.symbol === leg.symbol);
    const b = row ? legGapBp(row, sessionState) : null;
    if (b == null) return null;
    total += (leg.weightPct / 100) * b;
  }
  return total;
}

/**
 * What the gap is measured against, in words — the hero's labels, decided
 * from the legs' own cashPriceType, never from the clock alone (CLAUDE.md:
 * "labels come from data"). Legs with and without an extended-hours print
 * read "the latest cash prices".
 */
export function basketReferenceLabel(legs: BasketLeg[], rows: LegGapInput[], sessionState: string): string {
  if (sessionState === 'open') return 'the cash price';
  const mine = legs.map((l) => rows.find((r) => r.symbol === l.symbol)).filter((r): r is LegGapInput => r != null);
  const onPrint = mine.filter((r) => r.cashPriceType !== 'regular').length;
  if (sessionState.startsWith('closed') || onPrint === 0) {
    const closeMs = Math.max(0, ...mine.map((r) => r.closeAsOfMs ?? 0));
    return closeMs > 0
      ? `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(new Date(closeMs))}’s close`
      : 'the cash close';
  }
  if (onPrint < mine.length) return 'the latest cash prices';
  return `the cash ${sessionState === 'pre-market' ? 'pre-market' : 'after-hours'} price`;
}
