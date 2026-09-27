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
  /** Same "close vs current onchain mid" framing the homepage's gap-hero
   *  uses, not row.basisBp — see HomeClient's own comment on why those can
   *  disagree during pre-market/after-hours. Null when session is 'open'
   *  (basisBp itself is the right number then, this field isn't used). */
  headlineCloseBasisBp: number | null;
  /** Sum of depthUsd across every liquid-tier row — a single "real, on-chain
   *  liquidity sitting behind this tape" figure, not a per-symbol one. */
  totalLiquidDepthUsd: number;
  liquidCount: number;
  thinCount: number;
}

function closeBasisBp(row: TapeRow): number | null {
  return row.closeUsd != null && row.onchainMidUsd != null
    ? ((row.onchainMidUsd - row.closeUsd) / row.closeUsd) * 10_000
    : null;
}

function pickHeadline(rows: TapeRow[], useCloseBasis: boolean): TapeRow | null {
  let best: TapeRow | null = null;
  let bestAbs = -1;
  for (const row of rows) {
    const b = useCloseBasis ? closeBasisBp(row) : row.basisBp;
    if (b == null) continue;
    const abs = Math.abs(b);
    if (abs > bestAbs) {
      bestAbs = abs;
      best = row;
    }
  }
  return best;
}

export function buildTodaySnapshot(tape: TapeResult): TodaySnapshot {
  const marketOpen = tape.session.state === 'open';
  const { liquid, thin } = splitByLiquidity(tape.rows);

  // Same close-anchored basis the homepage's gap-hero uses while the cash
  // market is shut, so a screenshot of / and a screenshot of /today never
  // disagree about the same instant — live basisBp once it reopens.
  const useCloseBasis = !marketOpen;
  const headline = pickHeadline(liquid, useCloseBasis) ?? pickHeadline(thin, useCloseBasis);

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
    headlineCloseBasisBp: headline && useCloseBasis ? closeBasisBp(headline) : null,
    totalLiquidDepthUsd: liquid.reduce((sum, r) => sum + (r.depthUsd ?? 0), 0),
    liquidCount: liquid.length,
    thinCount: thin.length,
  };
}
