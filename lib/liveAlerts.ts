// Detects the events worth a toast by comparing two consecutive tape reads.
// Pure — no I/O, no React — so it can be tested on its own and so the same
// rules could later run on the server. Edge-triggered: a condition only fires
// when it becomes true, never on every poll while it holds.

import { isLiquid } from './liquidity';
import { bp, usd } from './format';

/** |basis| above this, on a liquid pool, counts as a gap worth a popup. */
export const GAP_ALERT_BP = 100;
/** The gap must fall back below this before it can fire again, so a name
 *  hovering around the threshold doesn't alert on every wobble. */
export const GAP_REARM_BP = 80;

export interface TapeRowLite {
  symbol: string;
  basisBp: number | null;
  depthUsd: number | null;
  cashLastUsd: number | null;
  onchainMidUsd: number | null;
}

export interface TapeLite {
  session: { state: string };
  rows: TapeRowLite[];
}

export interface AlertSnapshot {
  state: string;
  /** Symbols whose gap alert has fired and not yet re-armed. */
  fired: string[];
}

export interface LiveEvent {
  id: string;
  title: string;
  body: string;
  href?: string;
}

export function snapshotOf(tape: TapeLite): AlertSnapshot {
  return { state: tape.session.state, fired: [] };
}

/** First read has no previous state, so it only sets the baseline (including
 *  which gaps are already past the threshold) and fires nothing. */
export function detectEvents(prev: AlertSnapshot | null, tape: TapeLite): { events: LiveEvent[]; next: AlertSnapshot } {
  const liquid = tape.rows.filter((r) => isLiquid(r) && r.basisBp != null);
  const fired = new Set(prev?.fired ?? []);
  const events: LiveEvent[] = [];

  // Re-arm anything that has calmed down; mark the baseline silently.
  const overNow = new Set<string>();
  for (const r of liquid) {
    const abs = Math.abs(r.basisBp as number);
    if (abs > GAP_ALERT_BP) overNow.add(r.symbol);
    if (abs < GAP_REARM_BP) fired.delete(r.symbol);
  }

  if (prev) {
    const wasOpen = prev.state === 'open';
    const isOpen = tape.session.state === 'open';
    if (wasOpen !== isOpen) {
      const biggest = [...liquid].sort((a, b) => Math.abs(b.basisBp as number) - Math.abs(a.basisBp as number))[0];
      events.push({
        id: `session-${isOpen ? 'open' : 'close'}`,
        title: isOpen ? 'Cash market opened' : 'Cash market closed',
        body: biggest ? `Biggest gap: ${biggest.symbol} ${bp(biggest.basisBp)}` : 'Aerodrome keeps trading.',
        href: '/today',
      });
    }
    for (const r of liquid) {
      if (overNow.has(r.symbol) && !fired.has(r.symbol)) {
        events.push({
          id: `gap-${r.symbol}`,
          title: `${r.symbol} gap ${bp(r.basisBp)}`,
          body: `Cash ${usd(r.cashLastUsd)} → Aero ${usd(r.onchainMidUsd)}`,
          href: `/${r.symbol}`,
        });
      }
    }
  }

  // Everything over the threshold is now "fired" (new this tick, or already
  // over at baseline), so it stays quiet until it re-arms.
  for (const s of overNow) fired.add(s);

  return { events, next: { state: tape.session.state, fired: [...fired] } };
}
