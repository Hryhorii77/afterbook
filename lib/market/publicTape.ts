import type { TapeResult } from './tape';

// The frozen public shape shared by /api/v1/tape and the MCP get_tape tool —
// kept in one place so the two public-facing surfaces can't silently drift
// apart. Internal-only fields (cashTicker, name, cashStale, depthShares,
// cashAsOfMs) are deliberately dropped here, not just renamed.
export interface PublicTape {
  session: { state: string; label: string; nyTime: string };
  asOf: number;
  rows: Array<{
    symbol: string;
    cashUsd: number | null;
    midUsd: number | null;
    basisBp: number | null;
    depthUsd: number | null;
  }>;
}

export function toPublicTape(tape: TapeResult): PublicTape {
  return {
    session: { state: tape.session.state, label: tape.session.label, nyTime: tape.session.nyTime },
    asOf: tape.fetchedAt,
    rows: tape.rows.map((r) => ({
      symbol: r.symbol,
      cashUsd: r.cashLastUsd,
      midUsd: r.onchainMidUsd,
      basisBp: r.basisBp,
      depthUsd: r.depthUsd,
    })),
  };
}
