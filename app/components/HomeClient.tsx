'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { STOCKS, aerodromeSwapUrl, aerodromeDepositUrl } from '@/lib/tokens';
import type { TapeResult, TapeRow } from '@/lib/tape';
import { splitByLiquidity, LIQUID_DEPTH_THRESHOLD_USD } from '@/lib/liquidity';
import type { GeoInfo } from '@/lib/geo';
import { bp } from '@/lib/format';
import { ImpactCurve } from './ImpactCurve';
import { Sparkline } from './Sparkline';
import { MyLots } from './MyLots';

interface CurvePoint {
  usdcIn: number;
  impactBp: number;
  sharesOut: number;
  largeTradeCaveat: boolean;
}

interface QuoteResponse {
  symbol: string;
  usdcIn: number;
  sharesOut: number;
  midPriceUsd: number;
  execPriceUsd: number;
  impactBp: number;
  feeBp: number;
  largeTradeCaveat: boolean;
  curve: CurvePoint[];
}

interface HistorySample {
  ts: number;
  basisBp: number;
}

interface EventLogEntry {
  ts: number;
  text: string;
}

const SIZE_PRESETS_USDC = [250, 1_000, 5_000];

type SortKey = 'symbol' | 'cashLastUsd' | 'onchainMidUsd' | 'basisBp' | 'depthUsd';
type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

function sortRows(rows: TapeRow[], sort: SortState): TapeRow[] {
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

const usd = (n: number | null, digits = 2) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });


const shares = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const usdCompact = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};

const sharesCompact = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} sh`);

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (days > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatLogTime(ts: number): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(ts)) +
    ' ET'
  );
}

function formatNextOpen(iso: string): string {
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso)) + ' ET'
  );
}

const SORT_COLUMNS: { key: SortKey; label: (cashColumnLabel: string) => string }[] = [
  { key: 'symbol', label: () => 'Symbol' },
  { key: 'cashLastUsd', label: (cashColumnLabel) => cashColumnLabel },
  { key: 'onchainMidUsd', label: () => 'Aero mid' },
  { key: 'basisBp', label: () => 'Basis' },
  { key: 'depthUsd', label: () => 'Depth' },
];

function TapeHead({
  cashColumnLabel,
  sort,
  onSort,
}: {
  cashColumnLabel: string;
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  return (
    <thead>
      <tr>
        {SORT_COLUMNS.map((col) => (
          <th key={col.key} className="sortable-th" onClick={() => onSort(col.key)}>
            {col.label(cashColumnLabel)}
            <span className={sort?.key === col.key ? 'sort-indicator sort-indicator-active' : 'sort-indicator'}>
              {sort?.key === col.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅'}
            </span>
          </th>
        ))}
      </tr>
    </thead>
  );
}

function TapeRows({
  rows,
  activeSymbol,
  onSelect,
}: {
  rows: TapeRow[];
  activeSymbol: string;
  onSelect: (symbol: string) => void;
}) {
  return (
    <>
      {rows.map((row) => (
        <tr
          key={row.symbol}
          className={`tape-row-clickable${row.symbol === activeSymbol ? ' tape-row-active' : ''}`}
          onClick={() => onSelect(row.symbol)}
        >
          <td>
            <span className="symbol">{row.symbol}</span>
            <span className="symbol-name">{row.name}</span>
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
        </tr>
      ))}
    </>
  );
}

interface HomeClientProps {
  initialTape: TapeResult;
  initialGeo: GeoInfo;
  initialSymbol?: string;
}

export default function HomeClient({ initialTape, initialGeo, initialSymbol }: HomeClientProps) {
  const router = useRouter();
  const [tape, setTape] = useState<TapeResult>(initialTape);
  const [geo] = useState<GeoInfo>(initialGeo);
  const [eligibleChecked, setEligibleChecked] = useState(false);
  const [symbol, setSymbol] = useState(initialSymbol ?? STOCKS[0].symbol);
  const [usdcInput, setUsdcInput] = useState('2500');
  const [sort, setSort] = useState<SortState>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showThin, setShowThin] = useState(false);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const prevSessionStateRef = useRef(initialTape.session.state);

  const cashClosedAsOfMs =
    tape.session.state !== 'open' ? Math.max(0, ...tape.rows.map((r) => r.cashAsOfMs ?? 0)) : 0;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Initial tape already came from the server render — poll for refreshes
  // only, no redundant fetch on mount.
  useEffect(() => {
    let cancelled = false;
    const fetchTape = async () => {
      try {
        const res = await fetch('/api/tape');
        const json: TapeResult = await res.json();
        if (cancelled) return;
        setTape(json);

        // Precursor to real alerts (Phase 2) — a client-only, session-local
        // log of the one event we can detect for free: the cash market just
        // closed. Resets on reload by design; nothing here is persisted.
        const wasOpen = prevSessionStateRef.current === 'open';
        const nowClosed = json.session.state !== 'open';
        if (wasOpen && nowClosed) {
          const { liquid } = splitByLiquidity(json.rows);
          const parts = liquid.map((r) => `${r.cashTicker} Aero ${bp(r.basisBp)}`).join(' ');
          setEventLog((log) => [{ ts: Date.now(), text: `Cash closed. ${parts}` }, ...log].slice(0, 20));
        }
        prevSessionStateRef.current = json.session.state;
      } catch {
        // keep showing last good tape
      }
    };
    const id = setInterval(fetchTape, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const amount = Number(usdcInput);
    if (!Number.isFinite(amount) || amount <= 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&usdcIn=${amount}`);
        const json = await res.json();
        if (!res.ok) {
          setQuote(null);
          setQuoteError(json.error ?? 'quote failed');
          return;
        }
        setQuote(json);
        setQuoteError(null);
      } catch {
        setQuoteError('quote failed');
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [symbol, usdcInput]);

  // Chart doesn't need 20s freshness like the tape does — 60s keeps it
  // reasonably live without adding much KV read volume.
  useEffect(() => {
    let cancelled = false;
    const fetchHistory = async () => {
      try {
        const params = new URLSearchParams({ symbol });
        if (cashClosedAsOfMs > 0) params.set('since', String(cashClosedAsOfMs));
        const res = await fetch(`/api/history?${params.toString()}`);
        const json = await res.json();
        if (!cancelled) setHistory(json.samples ?? []);
      } catch {
        // keep showing last known history
      }
    };
    fetchHistory();
    const id = setInterval(fetchHistory, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol, cashClosedAsOfMs]);

  const unlocked = geo.nonUs === true && eligibleChecked;
  const activeStock = STOCKS.find((s) => s.symbol === symbol)!;
  const activeRow = tape.rows.find((r) => r.symbol === symbol);
  const cashColumnLabel = tape.session.state === 'open' ? 'Cash last' : 'Cash close';

  // replace (not push) so casually clicking through several names while
  // comparing doesn't spam the back-button history; scroll:false because
  // selectSymbol handles its own scroll-to-Lot-Lab.
  const setSymbolAndUrl = (sym: string) => {
    setSymbol(sym);
    router.replace(`/${sym}`, { scroll: false });
  };

  const selectSymbol = (sym: string) => {
    setSymbolAndUrl(sym);
    document.getElementById('lot-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggleSort = (key: SortKey) => {
    setSort((prev) => (!prev || prev.key !== key ? { key, dir: 'desc' } : { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }));
  };

  const copyTrade = async () => {
    if (!quote) return;
    const text = `Buy ${shares(quote.sharesOut)} ${activeStock.symbol} for ${usd(quote.usdcIn, 0)} USDC`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied — nothing to fall back to, button just won't confirm
    }
  };

  const showGapHero = tape.session.state !== 'open' && cashClosedAsOfMs > 0;

  // Real, deep pools vs freshly-listed thin ones don't belong at the same
  // visual rank — a $10k pool's basis swings hundreds of bp on noise alone
  // and reads as "the tape is broken" next to NVDAc's single-digit bp.
  const { liquid: liquidRows, thin: thinRows } = useMemo(() => splitByLiquidity(tape.rows), [tape.rows]);
  const sortedLiquidRows = useMemo(() => sortRows(liquidRows, sort), [liquidRows, sort]);
  const sortedThinRows = useMemo(() => sortRows(thinRows, sort), [thinRows, sort]);

  return (
    <main>
      <header className="top">
        <div>
          <h1>Afterbook</h1>
          <p className="tagline">Cash close vs the Aero book, in shares. Execution stays on Aerodrome.</p>
        </div>
        <span className="clock-badge">
          <span className={`dot ${tape.session.state}`} />
          {tape.session.label} · {tape.session.nyTime} ET
        </span>
      </header>

      {showGapHero && (
        <section className="panel gap-hero">
          <div className="gap-hero-title">Cash market closed {formatDuration(now - cashClosedAsOfMs)} ago</div>
          <div className="gap-hero-sub">
            Aerodrome has kept trading the whole time · Reopens {formatNextOpen(tape.session.nextOpenIso)}
          </div>
          <div className="gap-grid">
            {liquidRows.map((row) => (
              <button
                className={`gap-cell gap-cell-clickable${row.symbol === symbol ? ' gap-cell-active' : ''}`}
                key={row.symbol}
                onClick={() => selectSymbol(row.symbol)}
              >
                <div className="gap-symbol">{row.symbol}</div>
                <div className={row.basisBp != null ? (row.basisBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}>
                  {bp(row.basisBp)}
                </div>
                <div className="gap-detail">
                  {usd(row.cashLastUsd)} → {usd(row.onchainMidUsd)}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Basis since close · {activeStock.symbol}</h2>
        {history.length >= 2 ? (
          <Sparkline samples={history} />
        ) : (
          <p className="geo-note">Not enough history yet — this fills in as the app keeps running.</p>
        )}
      </section>

      <section className="panel">
        <h2>Tape</h2>
        <div className="table-scroll">
          <table>
            <TapeHead cashColumnLabel={cashColumnLabel} sort={sort} onSort={toggleSort} />
            <tbody>
              <TapeRows rows={sortedLiquidRows} activeSymbol={symbol} onSelect={selectSymbol} />
            </tbody>
          </table>
        </div>
        {tape.error && <p className="geo-note">{tape.error}</p>}

        {thinRows.length > 0 && (
          <div className="thin-books">
            <button className="thin-toggle" onClick={() => setShowThin((v) => !v)}>
              {showThin ? '▾' : '▸'} {showThin ? 'Hide' : 'Show'} {thinRows.length} thin book{thinRows.length === 1 ? '' : 's'}
            </button>
            {showThin && (
              <>
                <p className="geo-note">
                  Under ${(LIQUID_DEPTH_THRESHOLD_USD / 1000).toFixed(0)}k depth — basis here can swing hundreds of bp
                  on thin trading, not signal.
                </p>
                <div className="table-scroll">
                  <table className="thin-table">
                    <TapeHead cashColumnLabel={cashColumnLabel} sort={sort} onSort={toggleSort} />
                    <tbody>
                      <TapeRows rows={sortedThinRows} activeSymbol={symbol} onSelect={selectSymbol} />
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {eventLog.length > 0 && (
        <section className="panel">
          <h2>Log</h2>
          <ul className="event-log">
            {eventLog.map((entry) => (
              <li key={entry.ts}>
                <span className="event-log-time">{formatLogTime(entry.ts)}</span> {entry.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <MyLots />

      <section className="panel" id="lot-lab">
        <h2>Lot Lab</h2>
        <div className="lot-lab-form">
          <div className="field">
            <label htmlFor="symbol-select">Stock</label>
            <select id="symbol-select" value={symbol} onChange={(e) => setSymbolAndUrl(e.target.value)}>
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
            </select>
          </div>
          <div className="field">
            <label htmlFor="usdc-input">USDC in</label>
            <input
              id="usdc-input"
              type="number"
              min={1}
              step="1"
              value={usdcInput}
              onChange={(e) => setUsdcInput(e.target.value)}
            />
          </div>
        </div>

        <div className="size-presets">
          {SIZE_PRESETS_USDC.map((amt) => (
            <button key={amt} type="button" className="preset-btn" onClick={() => setUsdcInput(String(amt))}>
              {usdCompact(amt)}
            </button>
          ))}
          {activeRow?.depthUsd != null && (
            <button
              type="button"
              className="preset-btn"
              onClick={() => setUsdcInput(String(Math.max(1, Math.round(activeRow.depthUsd! * 0.01))))}
            >
              1% of pool
            </button>
          )}
        </div>

        {quoteError && <p className="geo-note">{quoteError}</p>}

        {quote && (
          <>
            <div className="result-hero">
              <div>
                <div className="label">Shares out</div>
                <div className="value">{shares(quote.sharesOut)}</div>
              </div>
              <button type="button" className="copy-trade-btn" onClick={copyTrade}>
                {copied ? 'Copied' : 'Copy trade'}
              </button>
            </div>
            <div className="result-grid">
              <div className="result-cell">
                <div className="label">Exec price</div>
                <div className="value">{usd(quote.execPriceUsd)}</div>
              </div>
              <div className="result-cell">
                <div className="label">Impact</div>
                <div className="value">{bp(quote.impactBp)}</div>
              </div>
              <div className="result-cell">
                <div className="label">Pool fee</div>
                <div className="value">{quote.feeBp.toFixed(0)} bp</div>
              </div>
            </div>

            <ImpactCurve points={quote.curve} currentUsdcIn={quote.usdcIn} currentImpactBp={quote.impactBp} />

            <p className="geo-note">
              Estimated from the pool&apos;s current on-chain price and in-range liquidity — not a firm quote.
              {quote.largeTradeCaveat && ' This size is large relative to in-range liquidity and may cross into a wider price range; the real fill on Aerodrome could differ from this estimate.'}
              {' '}Shaded region: sizes where the estimate is less reliable for the same reason.
            </p>

            <div className="lp-line">
              <span className="lp-line-label">Same {usd(quote.usdcIn, 0)} as LP</span>
              <span className="lp-line-value">
                ≈ {usd(quote.usdcIn / 2, 0)} + {shares(quote.usdcIn / 2 / quote.midPriceUsd)} {activeStock.symbol}
              </span>
            </div>
            <p className="geo-note">
              Full-range, ~50/50 by value at the current price — a full-range concentrated-liquidity position is
              mathematically equivalent to a classic 50/50 pool. Aerodrome defaults new deposits to a narrower
              range, which would change this split; check the actual range before depositing.
            </p>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Execute</h2>
        <div className="eligibility">
          <input
            type="checkbox"
            id="eligible"
            checked={eligibleChecked}
            onChange={(e) => setEligibleChecked(e.target.checked)}
          />
          <label htmlFor="eligible">
            I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
          </label>
        </div>
        <div className="actions">
          {unlocked ? (
            <>
              <a className="btn" href={aerodromeSwapUrl(activeStock)} target="_blank" rel="noopener noreferrer">
                Open {activeStock.symbol} on Aerodrome ↗
              </a>
              <a className="btn btn-secondary" href={aerodromeDepositUrl(activeStock)} target="_blank" rel="noopener noreferrer">
                Add {activeStock.symbol} liquidity
              </a>
            </>
          ) : (
            <>
              <button className="btn" disabled>
                Open {activeStock.symbol} on Aerodrome
              </button>
              <button className="btn btn-secondary" disabled>
                Add {activeStock.symbol} liquidity
              </button>
            </>
          )}
        </div>
        {!eligibleChecked && geo.nonUs && <p className="geo-note">Confirm eligibility to open Aerodrome.</p>}
        <p className={`geo-note${geo.country === 'US' ? ' geo-note-blocked' : ''}`}>
          {geo.country === 'US'
            ? 'Not available in the US — execution stays locked regardless of the checkbox above. '
            : geo.country
              ? `Detected region: ${geo.country}. `
              : 'Region could not be detected (e.g. local dev). '}
          This is a best-effort geofence based on IP country, not a compliance control — it does not stop a VPN.
          No wallet ever signs anything here; the button only opens Aerodrome&apos;s own app in a new tab.
        </p>
      </section>

      <footer>
        <p>
          Afterbook reads Aerodrome&apos;s on-chain pool state and public cash-market prices server-side, and never
          holds keys, requests approvals, or constructs swap calldata. All trading, lending, and liquidity actions
          happen on Aerodrome&apos;s own app.
        </p>
        <ul>
          <li>
            Allowlisted contracts only — {STOCKS.length} token addresses and {STOCKS.length} pool addresses, verified
            on-chain
          </li>
          <li>Server-side fetches; the browser only talks to this site&apos;s own /api routes</li>
          <li>My Lots connects a wallet to read balances only — no seed phrase, no approvals, no custom router, no signature ever requested</li>
          <li>Official Aerodrome URLs only for every execution link</li>
        </ul>
        <p>MIT licensed.</p>
      </footer>
    </main>
  );
}
