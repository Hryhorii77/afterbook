'use client';

// The tape's table, phone cards, column header, freshness line and the sort/trend helpers they share.
// Moved out of HomeClient.tsx (2026-10-29) unchanged; HomeClient owns the state and passes it in.
import { useEffect, useState } from 'react';
import type { TapeResult, TapeRow } from '@/lib/tape';
import { bp, usd, usdCompact } from '@/lib/format';
import { SymbolTile } from './SymbolTile';
import { MiniSpark, sparkSummary } from './MiniSpark';

export type SortKey = 'symbol' | 'cashLastUsd' | 'onchainMidUsd' | 'basisBp' | 'depthUsd';
export type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

export function sortRows(rows: TapeRow[], sort: SortState): TapeRow[] {
  if (!sort) return rows;
  const { key, dir } = sort;
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'symbol') return factor * a.symbol.localeCompare(b.symbol);
    const av = a[key];
    const bv = b[key];
    // Missing values sink to the bottom regardless of sort direction —
    // there's no meaningful "highest" or "lowest" for a value that isn't there.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return factor * (av - bv);
  });
}

export const sharesCompact = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} sh`);

export const EARNINGS_CAVEAT_WINDOW_DAYS = 5;

// isoDate is a plain YYYY-MM-DD (UTC midnight), so diffing against UTC
// midnight of "now" avoids a client-timezone off-by-one.
export function daysUntil(isoDate: string): number {
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  const todayUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((target - todayUtc) / 86_400_000);
}

export const SORT_COLUMNS: { key: SortKey; label: (cashColumnLabel: string) => string }[] = [
  { key: 'symbol', label: () => 'Symbol' },
  { key: 'cashLastUsd', label: (cashColumnLabel) => cashColumnLabel },
  { key: 'onchainMidUsd', label: () => 'Onchain price' },
  { key: 'basisBp', label: () => 'Gap' },
  { key: 'depthUsd', label: () => 'Pool liquidity' },
];

// The tape and thin-books tables are two separate <table> elements, so
// with the default auto layout each sizes its own columns from its own
// content — a long thin-book name/price (e.g. "Space Exploration
// Technologies Corp.", "$1,791.82") throws its column widths out of sync
// with the table above it. Fixed, shared percentages (paired with
// `table-layout: fixed` in globals.css) keep both tables' columns lined up
// regardless of what either one's rows contain.
export const TAPE_COLUMN_WIDTHS = ['23%', '12%', '12%', '11%', '17%', '10%', '15%'];

export interface TrendData {
  /** Prices on one shared time axis; null before a token's first sample. */
  series: Record<string, (number | null)[]>;
  /** Days of history each token actually has. */
  spanDays: Record<string, number>;
  change24h: Record<string, number | null>;
  /** Days of history the charts actually cover (up to 30). */
  days: number;
}

/** Fewer days of history than this and the row says "New" instead of drawing a chart. */
export const MIN_TREND_DAYS = 3;

// "NVIDIA Corporation" -> "NVIDIA (NVDA)". The ticker keeps names that are also plain words
// ("Strategy") unambiguous; very long names fall back to the ticker alone.

export const pct = (n: number) => `${Math.abs(n).toFixed(2)}%`;

/** How old the numbers are. Delayed when the tape is over 90 s old (the page refreshes it every
 *  20 s), when the server says it is serving last known values, or when the last refresh from this
 *  page failed. Only the state word is a live region, so a screen reader hears "Delayed" once
 *  rather than every tick of the clock. */
export const TAPE_DELAYED_AFTER_MS = 90_000;

export function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s / 5) * 5}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

export function TapeFreshness({ tape, refreshFailed }: { tape: TapeResult; refreshFailed: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const age = now - tape.fetchedAt;
  const delayed = refreshFailed || Boolean(tape.error) || age > TAPE_DELAYED_AFTER_MS;
  const staleCash = tape.rows.filter((r) => r.cashStale).map((r) => r.symbol);
  return (
    <p className={`tape-freshness${delayed ? ' tape-freshness-delayed' : ''}`}>
      <span className="tape-freshness-dot" aria-hidden="true" />
      <span aria-live="polite">{delayed ? 'Delayed' : 'Live'}</span>
      {delayed ? ` · last updated ${ageText(age)}` : ` · updated ${ageText(age)} · refreshes every 20s`}
      {refreshFailed && ' · this page could not refresh, retrying'}
      {staleCash.length > 0 &&
        ` · cash price delayed for ${staleCash.length > 4 ? `${staleCash.length} stocks` : staleCash.join(', ')} (last good value shown)`}
    </p>
  );
}

export function TapeColGroup() {
  return (
    <colgroup>
      {TAPE_COLUMN_WIDTHS.map((width, i) => (
        <col key={i} style={{ width }} />
      ))}
    </colgroup>
  );
}

export function TapeHead({
  cashColumnLabel,
  sort,
  onSort,
  trendDays,
}: {
  cashColumnLabel: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
  trendDays: number | null;
}) {
  return (
    <thead>
      <tr>
        {SORT_COLUMNS.map((col) => {
          const on = sort?.key === col.key;
          const label = col.label(cashColumnLabel);
          return (
            <th key={col.key} className="sortable-th" aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
              <button
                type="button"
                className="sort-btn"
                onClick={() => onSort(col.key)}
                aria-label={`Sort by ${label}${on ? `, now ${sort.dir === 'asc' ? 'lowest' : 'highest'} first` : ''}`}
              >
                {label}
                <span className={on ? 'sort-indicator sort-indicator-active' : 'sort-indicator'} aria-hidden="true">
                  {on ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅'}
                </span>
              </button>
            </th>
          );
        })}
        <th>24h</th>
        <th>{trendDays ? `Past ${trendDays}d` : 'Trend'}</th>
      </tr>
    </thead>
  );
}

export function TapeRows({
  rows,
  activeSymbol,
  onSelect,
  trend,
}: {
  rows: TapeRow[];
  activeSymbol: string;
  onSelect: (symbol: string) => void;
  trend: TrendData | null;
}) {
  return (
    <>
      {rows.map((row) => (
        <tr
          key={row.symbol}
          className={`tape-row-clickable${row.symbol === activeSymbol ? ' tape-row-active' : ''}`}
          onClick={() => onSelect(row.symbol)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(row.symbol);
            }
          }}
        >
          <td>
            <div className="sym-cell">
              <SymbolTile cashTicker={row.cashTicker} />
              <div className="sym-cell-text">
                <span className="symbol">{row.symbol}</span>
                <span className="symbol-name" title={row.name}>{row.name}</span>
                {row.nextEarningsDate != null && daysUntil(row.nextEarningsDate) <= EARNINGS_CAVEAT_WINDOW_DAYS && daysUntil(row.nextEarningsDate) >= 0 && (
                  <span className="earnings-tag">Earnings in {daysUntil(row.nextEarningsDate)}d</span>
                )}
              </div>
            </div>
          </td>
          <td>
            {usd(row.cashLastUsd)}
            {row.cashStale && <span className="stale-tag">STALE</span>}
          </td>
          <td>{usd(row.onchainMidUsd)}</td>
          <td className={`basis-cell ${row.basisBp != null ? (row.basisBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}`}>
            {bp(row.basisBp)}
          </td>
          <td className="depth-cell">
            <div className="depth-cell-inner">
              <span className="depth-usd">{usdCompact(row.depthUsd)}</span>
              <span className="depth-sep">·</span>
              <span className="depth-shares">{sharesCompact(row.depthShares)}</span>
            </div>
          </td>
          <td className={`change-cell ${trend?.change24h[row.symbol] != null ? ((trend.change24h[row.symbol] as number) >= 0 ? 'basis-pos' : 'basis-neg') : ''}`}>
            {trend?.change24h[row.symbol] != null ? `${(trend.change24h[row.symbol] as number) >= 0 ? '▲' : '▼'} ${pct(trend.change24h[row.symbol] as number)}` : '—'}
          </td>
          <td className="spark-cell">
            {trend && (trend.spanDays[row.symbol] ?? 0) < MIN_TREND_DAYS ? (
              // Too little history for a meaningful line (it would be a few pixels wide): say so.
              <span className="mini-spark-new">New · {Math.max(1, Math.round(trend.spanDays[row.symbol] ?? 0))}d</span>
            ) : (
              <MiniSpark values={trend?.series[row.symbol]} label={`Onchain price, past ${trend?.days ?? ''} days`} />
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

// Mobile-only alternative to TapeRows' <table>, rendered alongside it and
// toggled by CSS at the same 768px breakpoint used elsewhere in this file
// (not a media-query-in-JS check) — no hydration mismatch risk, and no
// duplicated data-fetching. A fixed 5-column table doesn't fit a 390px
// screen without horizontal scroll; a stacked card does.
export function TapeCards({
  rows,
  activeSymbol,
  onSelect,
  trend,
}: {
  rows: TapeRow[];
  activeSymbol: string;
  onSelect: (symbol: string) => void;
  trend: TrendData | null;
}) {
  // Phones show what to compare (gap, the two prices, pool liquidity); the rest opens under
  // Details, one card at a time. Nothing is remembered between visits.
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="tape-cards">
      {rows.map((row) => {
        const change = trend?.change24h[row.symbol];
        const earningsSoon =
          row.nextEarningsDate != null && daysUntil(row.nextEarningsDate) <= EARNINGS_CAVEAT_WINDOW_DAYS && daysUntil(row.nextEarningsDate) >= 0;
        const detailsId = `tape-card-details-${row.symbol}`;
        const isOpen = open === row.symbol;
        return (
          <div key={row.symbol} className={`tape-card${row.symbol === activeSymbol ? ' tape-card-active' : ''}`}>
            <button type="button" className="tape-card-main" onClick={() => onSelect(row.symbol)} aria-pressed={row.symbol === activeSymbol}>
              <div className="tape-card-top">
                <span className="tape-card-id">
                  <SymbolTile cashTicker={row.cashTicker} size="sm" />
                  <span className="symbol">{row.symbol}</span>
                </span>
                <span className={`tape-card-basis ${row.basisBp != null ? (row.basisBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}`}>
                  {bp(row.basisBp)}
                </span>
              </div>
              <div className="tape-card-name">
                {row.name}
                {earningsSoon && <span className="earnings-tag">Earnings in {daysUntil(row.nextEarningsDate!)}d</span>}
              </div>
              <div className="tape-card-prices">
                {usd(row.cashLastUsd)} cash{row.cashStale && <span className="stale-tag">STALE</span>} → {usd(row.onchainMidUsd)} onchain
              </div>
              <div className="tape-card-depth">{usdCompact(row.depthUsd)} pool liquidity</div>
            </button>
            <button
              type="button"
              className="tape-card-more"
              aria-expanded={isOpen}
              aria-controls={detailsId}
              onClick={() => setOpen(isOpen ? null : row.symbol)}
            >
              {isOpen ? '▾' : '▸'} Details
            </button>
            {isOpen && (
              <dl id={detailsId} className="tape-card-details">
                <div>
                  <dt>24h, onchain price</dt>
                  <dd className={change != null ? (change >= 0 ? 'basis-pos' : 'basis-neg') : ''}>
                    {change != null ? `${change >= 0 ? '▲' : '▼'} ${pct(change)}` : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Shares in the pool</dt>
                  <dd>{sharesCompact(row.depthShares)}</dd>
                </div>
                <div className="tape-card-details-wide">
                  <dt>{trend?.days ? `Past ${trend.days} days` : 'Trend'}</dt>
                  <dd>
                    {trend && (trend.spanDays[row.symbol] ?? 0) < MIN_TREND_DAYS ? (
                      <span className="mini-spark-new">New · {Math.max(1, Math.round(trend.spanDays[row.symbol] ?? 0))}d</span>
                    ) : (
                      <>
                        <MiniSpark values={trend?.series[row.symbol]} label={`Onchain price, past ${trend?.days ?? ''} days`} />
                        <span className="tape-card-spark-text">{sparkSummary(trend?.series[row.symbol])}</span>
                      </>
                    )}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        );
      })}
    </div>
  );
}
