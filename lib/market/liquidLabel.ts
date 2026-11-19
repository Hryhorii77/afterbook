// Client-safe pieces of the "Liquid" label (lib/market/liquidityBar.ts holds the server side): the bar, the types
// and the words shown. No server imports here, so client components can use it.
import { usdCompact } from '../format';

export const LIQUID_BAR_USD = 100_000;

export type LiquidStatus = 'liquid' | 'thin' | 'measuring';
export interface LiquidBarRow {
  status: LiquidStatus;
  /** The lowest depth seen over the window (null while measuring with no reads). */
  lowUsd: number | null;
  /** Share of the window's slots with a good read for this stock, 0–1. */
  coverage: number;
}

/** The short label: "Liquid · 72h low $1.7M", "Thin · 72h low $26k" or "Liquidity: measuring". */
export function liquidLabel(row: LiquidBarRow | undefined | null): string | null {
  if (!row) return null;
  if (row.status === 'measuring') return 'Liquidity: measuring';
  const low = row.lowUsd != null ? ` · 72h low ${usdCompact(row.lowUsd)}` : '';
  return `${row.status === 'liquid' ? 'Liquid' : 'Thin'}${low}`;
}
