import type { TapeResult, TapeRow } from './tape';
import { splitByLiquidity } from './liquidity';

export interface TodaySnapshot {
  sessionLabel: string;
  /** Cash market has been closed this long (ms), or 0 while it's open. */
  closedForMs: number;
  nextOpenIso: string;
  /** The single row worth leading with: largest |basis| among liquid names,
   *  falling back to the largest among thin ones if no liquid pool has a
   *  reading yet — never silently drops the headline stat to "—" just
   *  because the deepest pools happen to be flat right now. */
  headline: TapeRow | null;
  /** Sum of depthUsd across every liquid-tier row — a single "real, on-chain
   *  liquidity sitting behind this tape" figure, not a per-symbol one. */
  totalLiquidDepthUsd: number;
  liquidCount: number;
  thinCount: number;
}

/** What /today measures a stock's gap against right now, in the same rule as the home page's hero
 *  (heroGapBp in lib/shareText.ts), so the two never disagree about the same instant: the live cash
 *  price while the market is open; a live pre-market or after-hours trade when the row has one; the
 *  last regular close otherwise (overnight, weekends, or no extended-hours trade yet). */
export interface TodayReference {
  bp: number | null;
  cashUsd: number | null;
  /** Ends "the cash …": "price", "close", "after-hours price", "pre-market price". */
  word: string;
  /** The cash card's label: "Cash price", "Cash close", "Cash after-hours", "Cash pre-market". */
  cardLabel: string;
}

export function todayReference(row: TapeRow, session: Pick<TapeResult['session'], 'state'>): TodayReference {
  if (session.state === 'open') return { bp: row.basisBp, cashUsd: row.cashLastUsd, word: 'price', cardLabel: 'Cash price' };
  const extended = !session.state.startsWith('closed') && (row.cashPriceType === 'pre-market' || row.cashPriceType === 'after-hours');
  if (extended) {
    const name = row.cashPriceType === 'pre-market' ? 'pre-market' : 'after-hours';
    return { bp: row.basisBp, cashUsd: row.cashLastUsd, word: `${name} price`, cardLabel: `Cash ${name}` };
  }
  return { bp: closeBasisBp(row), cashUsd: row.closeUsd, word: 'close', cardLabel: 'Cash close' };
}

export function closeBasisBp(row: TapeRow): number | null {
  return row.closeUsd != null && row.onchainMidUsd != null
    ? ((row.onchainMidUsd - row.closeUsd) / row.closeUsd) * 10_000
    : null;
}

function pickHeadline(rows: TapeRow[], session: Pick<TapeResult['session'], 'state'>): TapeRow | null {
  let best: TapeRow | null = null;
  let bestAbs = -1;
  for (const row of rows) {
    const b = todayReference(row, session).bp;
    if (b == null) continue;
    const abs = Math.abs(b);
    if (abs > bestAbs) {
      bestAbs = abs;
      best = row;
    }
  }
  return best;
}

export function buildTodaySnapshot(tape: Pick<TapeResult, 'rows' | 'session'>): TodaySnapshot {
  const marketOpen = tape.session.state === 'open';
  const { liquid, thin } = splitByLiquidity(tape.rows);

  // The same reference the homepage's gap-hero uses (todayReference), so a screenshot of / and a
  // screenshot of /today never disagree about the same instant.
  const headline = pickHeadline(liquid, tape.session) ?? pickHeadline(thin, tape.session);

  const closedForMs = marketOpen
    ? 0
    : Math.max(0, ...tape.rows.map((r) => r.closeAsOfMs ?? 0).filter((ms) => ms > 0), 0);
  // Math.max(0, ...[], 0) on an empty filtered array still yields 0 — the
  // "no close data yet" case reads as "just closed" rather than NaN/-Infinity.

  return {
    sessionLabel: tape.session.label,
    closedForMs: closedForMs > 0 ? Date.now() - closedForMs : 0,
    nextOpenIso: tape.session.nextOpenIso,
    headline,
    totalLiquidDepthUsd: liquid.reduce((sum, r) => sum + (r.depthUsd ?? 0), 0),
    liquidCount: liquid.length,
    thinCount: thin.length,
  };
}
