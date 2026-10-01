import type { TapeResult, TapeRow } from '../tape';
import { getStock } from '../tokens';
import { computeTiltWeights, type BasketWeight } from './weights';

// Base mainnet, where every tracked B20 token lives.
export const BASE_CHAIN_ID = 8453;

/** CAIP-19 id Glider expects for an ERC-20 on Base. The address is the exact
 *  string in lib/tokens.ts. Whether Glider wants it lowercased is unconfirmed —
 *  strategies/validate will say. */
export function assetIdFor(symbol: string): string {
  const stock = getStock(symbol);
  if (!stock) throw new Error(`unknown symbol ${symbol}`);
  return `eip155:${BASE_CHAIN_ID}/erc20:${stock.tokenAddress}`;
}

// Same close-anchored basis /today and the homepage gap-hero use while the
// cash market is shut, live basisBp once it reopens — so the tilt never
// disagrees with the number shown next to it.
function tiltBasisBp(row: TapeRow, marketOpen: boolean): number | null {
  if (marketOpen) return row.basisBp;
  return row.closeUsd != null && row.onchainMidUsd != null
    ? ((row.onchainMidUsd - row.closeUsd) / row.closeUsd) * 10_000
    : row.basisBp;
}

export interface TiltRow extends BasketWeight {
  assetId: string;
  basisBp: number | null;
  depthUsd: number | null;
}

// The names Basis Tilt holds. Deliberately separate from the tracked list in
// lib/tokens.ts: adding a stock to the tape must NOT silently change what
// enrolled users hold. Widening the basket is an explicit decision (and a new
// strategy version), made once a name's pool is deep enough.
export const BASKET_SYMBOLS: readonly string[] = [
  'NVDAc', 'AAPLc', 'METAc', 'GOOGLc', 'AMZNc', 'MSFTc', 'MSTRc', 'SNDKc', 'SPCXc', 'TSLAc',
];

export function buildTilt(tape: TapeResult): TiltRow[] {
  const marketOpen = tape.session.state === 'open';
  const inputs = tape.rows.filter((row) => BASKET_SYMBOLS.includes(row.symbol)).map((row) => ({
    symbol: row.symbol,
    depthUsd: row.depthUsd,
    basisBp: tiltBasisBp(row, marketOpen),
  }));
  const byInput = new Map(inputs.map((i) => [i.symbol, i]));
  return computeTiltWeights(inputs)
    .map((w) => ({
      ...w,
      assetId: assetIdFor(w.symbol),
      basisBp: byInput.get(w.symbol)!.basisBp,
      depthUsd: byInput.get(w.symbol)!.depthUsd,
    }))
    .sort((a, b) => b.weightHundredths - a.weightHundredths);
}
