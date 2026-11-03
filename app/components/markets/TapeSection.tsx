// The tape: every tracked stock's gap, price and pool, sortable; pools under TAPE_MAIN_DEPTH_USD
// behind a toggle.
import { useMemo, useState } from 'react';
import type { TapeResult, TapeRow } from '@/lib/tape';
import { TAPE_MAIN_DEPTH_USD } from '@/lib/liquidity';
import { usdCompact } from '@/lib/format';
import { sortRows, TapeCards, TapeColGroup, TapeFreshness, TapeHead, TapeRows, type SortKey, type SortState, type TrendData } from '../Tape';

interface Props {
  tape: TapeResult;
  refreshFailed: boolean;
  trend: TrendData | null;
  liquidRows: TapeRow[];
  thinRows: TapeRow[];
  symbol: string;
  selectSymbol: (sym: string) => void;
}

export function TapeSection({ tape, refreshFailed, trend, liquidRows, thinRows, symbol, selectSymbol }: Props) {
  const [sort, setSort] = useState<SortState>(null);
  const [showThin, setShowThin] = useState(false);
  const sortedLiquidRows = useMemo(() => sortRows(liquidRows, sort), [liquidRows, sort]);
  const sortedThinRows = useMemo(() => sortRows(thinRows, sort), [thinRows, sort]);

  // The table's cash column is labelled from what the rows actually hold, not from the clock:
  // in pre-market/after-hours a row only carries an extended-hours price when Yahoo had a real
  // print (cashPriceType); otherwise its "cash" price is still the last regular close.
  const extendedState = tape.session.state === 'pre-market' || tape.session.state === 'after-hours';
  const extendedName = tape.session.state === 'pre-market' ? 'pre-market' : 'after-hours';
  const rowsOnPrint = tape.rows.filter((r) => r.cashPriceType !== 'regular').length;
  const cashColumnLabel =
    tape.session.state === 'open'
      ? 'Cash last'
      : !extendedState || rowsOnPrint === 0
        ? 'Cash close'
        : rowsOnPrint === tape.rows.length
          ? `Cash ${extendedName}`
          : 'Cash (latest)';

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (!prev || prev.key !== key ? { key, dir: 'desc' } : { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  return (
    <section className="panel" id="tape">
      <h2>Tape</h2>
      <TapeFreshness tape={tape} refreshFailed={refreshFailed} />
      {extendedState && (
        <p className="geo-note" style={{ marginTop: 0 }}>
          {rowsOnPrint === 0
            ? `No ${extendedName} trades yet, so the gap is measured against the last regular-session close.`
            : rowsOnPrint === tape.rows.length
              ? `The gap is against a live ${extendedName} print, not the regular-session close — extended-hours trading is thinner, so this can move more than the regular-session number would.`
              : `The gap is against a live ${extendedName} print where there is one and the last regular-session close otherwise — extended-hours trading is thinner, so this can move more than the regular-session number would.`}
        </p>
      )}
      <details className="tape-legend">
        <summary>What the columns mean</summary>
        <dl>
          <div><dt>Gap</dt><dd>Onchain price minus cash price, in basis points: 100 bp = 1%. Green: the token costs more than the stock; red: less.</dd></div>
          <div><dt>Onchain price</dt><dd>What the stock token trades for on Aero (formerly Aerodrome), the Base exchange that never closes.</dd></div>
          <div><dt>Pool liquidity</dt><dd>Dollars and shares in the token&apos;s pool on Aero: how big a trade it takes before the price moves much.</dd></div>
          <div><dt>24h</dt><dd>How the onchain price moved over the last 24 hours.</dd></div>
          <div><dt>Trend</dt><dd>The onchain price over the past days; hover or tap for the change in words.</dd></div>
        </dl>
      </details>
      <div className="table-scroll tape-table-desktop">
        <table>
          <TapeColGroup />
          <TapeHead cashColumnLabel={cashColumnLabel} sort={sort} onSort={toggleSort} trendDays={trend?.days ?? null} />
          <tbody>
            <TapeRows rows={sortedLiquidRows} activeSymbol={symbol} onSelect={selectSymbol} trend={trend} />
          </tbody>
        </table>
      </div>
      <TapeCards rows={sortedLiquidRows} activeSymbol={symbol} onSelect={selectSymbol} trend={trend} />
      {tape.error && <p className="geo-note">{tape.error}</p>}

      {thinRows.length > 0 && (
        <div className="thin-books">
          <button className="thin-toggle" onClick={() => setShowThin((v) => !v)}>
            {showThin ? '▾' : '▸'} {showThin ? 'Hide' : 'Show'} {thinRows.length} smaller pool{thinRows.length === 1 ? '' : 's'}
          </button>
          {showThin && (
            <>
              <p className="geo-note">
                Under {usdCompact(TAPE_MAIN_DEPTH_USD)} in the pool: the gap here can swing hundreds of bp on small
                trades, so it says little.
              </p>
              <div className="table-scroll tape-table-desktop">
                <table className="thin-table">
                  <TapeColGroup />
                  <TapeHead cashColumnLabel={cashColumnLabel} sort={sort} onSort={toggleSort} trendDays={trend?.days ?? null} />
                  <tbody>
                    <TapeRows rows={sortedThinRows} activeSymbol={symbol} onSelect={selectSymbol} trend={trend} />
                  </tbody>
                </table>
              </div>
              <TapeCards rows={sortedThinRows} activeSymbol={symbol} onSelect={selectSymbol} trend={trend} />
            </>
          )}
        </div>
      )}
    </section>
  );
}
