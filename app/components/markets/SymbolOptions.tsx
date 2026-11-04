import type { TapeRow } from '@/lib/market/tape';

/** The stock picker's options: the tape's main list, then the smaller pools. */
export function SymbolOptions({ liquidRows, thinRows }: { liquidRows: TapeRow[]; thinRows: TapeRow[] }) {
  return (
    <>
      <optgroup label="Liquid">
        {liquidRows.map((r) => (
          <option key={r.symbol} value={r.symbol}>
            {r.symbol}
          </option>
        ))}
      </optgroup>
      {thinRows.length > 0 && (
        <optgroup label="Thin">
          {thinRows.map((r) => (
            <option key={r.symbol} value={r.symbol}>
              {r.symbol}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}
