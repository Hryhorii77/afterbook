'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { STOCKS, aerodromeSwapUrl, aerodromeDepositUrl } from '@/lib/tokens';
import type { TapeResult, TapeRow } from '@/lib/tape';
import { splitByLiquidity, LIQUID_DEPTH_THRESHOLD_USD } from '@/lib/liquidity';
import type { GeoInfo } from '@/lib/geo';
import { bp } from '@/lib/format';
import { ImpactCurve } from './ImpactCurve';
import { DepthChart } from './DepthChart';
import { computeCashAndCarryEdge, GAS_ESTIMATE_USD } from '@/lib/arb';
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

interface ClosedPeriodStats {
  count: number;
  meanBp: number;
  meanAbsBp: number;
  maxAbsBp: number;
}

interface EventLogEntry {
  ts: number;
  text: string;
}

interface LiquidityBucket {
  tickLower: number;
  tickUpper: number;
  priceLowerUsd: number;
  priceUpperUsd: number;
  liquidity: string;
}

interface DepthResponse {
  symbol: string;
  currentTick: number;
  currentPriceUsd: number;
  buckets: LiquidityBucket[];
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

const truncateAddr = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

const usdCompact = (n: number | null) => {
  if (n == null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};

const sharesCompact = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} sh`);

const EARNINGS_CAVEAT_WINDOW_DAYS = 5;

// isoDate is a plain YYYY-MM-DD (UTC midnight), so diffing against UTC
// midnight of "now" avoids a client-timezone off-by-one.
function daysUntil(isoDate: string): number {
  const target = new Date(`${isoDate}T00:00:00Z`).getTime();
  const todayUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((target - todayUtc) / 86_400_000);
}

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
            {row.nextEarningsDate != null && daysUntil(row.nextEarningsDate) <= EARNINGS_CAVEAT_WINDOW_DAYS && daysUntil(row.nextEarningsDate) >= 0 && (
              <span className="earnings-tag">Earnings in {daysUntil(row.nextEarningsDate)}d</span>
            )}
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
  const [tape, setTape] = useState<TapeResult>(initialTape);
  const [geo] = useState<GeoInfo>(initialGeo);
  const [eligibleChecked, setEligibleChecked] = useState(false);
  const [symbol, setSymbol] = useState(initialSymbol ?? STOCKS[0].symbol);
  const [usdcInput, setUsdcInput] = useState('2500');
  const [sort, setSort] = useState<SortState>(null);
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [depth, setDepth] = useState<DepthResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showThin, setShowThin] = useState(false);
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [basisStats, setBasisStats] = useState<ClosedPeriodStats | null>(null);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [amountCopied, setAmountCopied] = useState(false);
  const prevSessionStateRef = useRef(initialTape.session.state);

  const cashClosedAsOfMs =
    tape.session.state !== 'open' ? Math.max(0, ...tape.rows.map((r) => r.closeAsOfMs ?? 0)) : 0;

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

  // Depth is keyed only on symbol (not usdcInput) — it's the pool's whole
  // tick-range profile, not sized to a particular trade. Same 60s cadence
  // as history: this doesn't need tape's 20s freshness.
  useEffect(() => {
    let cancelled = false;
    const fetchDepth = async () => {
      try {
        const res = await fetch(`/api/depth?symbol=${encodeURIComponent(symbol)}`);
        const json = await res.json();
        if (!cancelled) setDepth(res.ok ? json : null);
      } catch {
        // keep showing last known distribution
      }
    };
    fetchDepth();
    const id = setInterval(fetchDepth, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  // A 30-day aggregate barely moves minute to minute — fetch on symbol
  // change only, no polling interval needed.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/history/stats?symbol=${encodeURIComponent(symbol)}`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setBasisStats(json.stats ?? null);
      })
      .catch(() => {
        if (!cancelled) setBasisStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const unlocked = geo.nonUs === true && eligibleChecked;
  const activeStock = STOCKS.find((s) => s.symbol === symbol)!;
  const activeRow = tape.rows.find((r) => r.symbol === symbol);

  // Only meaningful while cash is closed — once it's open there's no
  // "carry until reopen" window left to annualize over, same gate
  // showGapHero already uses below.
  const arbEdge = useMemo(() => {
    if (tape.session.state === 'open' || !quote || activeRow?.basisBp == null) return null;
    const msUntilOpen = new Date(tape.session.nextOpenIso).getTime() - now;
    return computeCashAndCarryEdge(activeRow.basisBp, quote.feeBp, quote.impactBp, quote.usdcIn, msUntilOpen);
  }, [tape.session.state, tape.session.nextOpenIso, quote, activeRow?.basisBp, now]);
  const cashColumnLabel =
    tape.session.state === 'open'
      ? 'Cash last'
      : tape.session.state === 'pre-market'
        ? 'Cash pre-market'
        : tape.session.state === 'after-hours'
          ? 'Cash after-hours'
          : 'Cash close';

  // Plain history API, not next/navigation's router.replace() — /[symbol]
  // is backed by an async Server Component (app/[symbol]/page.tsx) that
  // re-fetches getTape()/getGeoInfo() on every navigation. router.replace()
  // was triggering that full server round-trip on every single symbol
  // click even though this component already has everything it needs
  // client-side, and its arrival raced the scrollIntoView call below —
  // depending on network timing that produced anything from no scroll at
  // all, to a layout shift mid-scroll from the freshly-streamed data. A
  // plain URL update has no data fetch to race.
  const setSymbolAndUrl = (sym: string) => {
    setSymbol(sym);
    window.history.replaceState(null, '', `/${sym}`);
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

  // Aerodrome's swap URL has no amount param (verified live — from/to/chain
  // are the only ones it reads), so the closest we can get to a deep-linked
  // trade size is a paste instead of a retype.
  const copyAmount = async () => {
    if (!quote) return;
    try {
      await navigator.clipboard.writeText(String(quote.usdcIn));
      setAmountCopied(true);
      setTimeout(() => setAmountCopied(false), 1500);
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
            {liquidRows.map((row) => {
              // Deliberately close-anchored, not row.basisBp — that field
              // now reflects the live pre-market/after-hours print when
              // one exists (see lib/tape.ts), which would silently
              // disagree with this card's own "since that exact close"
              // headline on exactly the days a real extended-hours move
              // happened. Badge and arrow here always tell the same story.
              const closeBasisBp =
                row.closeUsd != null && row.onchainMidUsd != null
                  ? ((row.onchainMidUsd - row.closeUsd) / row.closeUsd) * 10_000
                  : null;
              return (
                <button
                  className={`gap-cell gap-cell-clickable${row.symbol === symbol ? ' gap-cell-active' : ''}`}
                  key={row.symbol}
                  onClick={() => selectSymbol(row.symbol)}
                >
                  <div className="gap-symbol">{row.symbol}</div>
                  <div className={closeBasisBp != null ? (closeBasisBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}>
                    {bp(closeBasisBp)}
                  </div>
                  <div className="gap-detail">
                    {usd(row.closeUsd)} → {usd(row.onchainMidUsd)}
                  </div>
                </button>
              );
            })}
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
        {basisStats && (
          <p className="geo-note">
            Last 30 days (market closed): avg {bp(basisStats.meanBp)}, max {bp(basisStats.maxAbsBp)}, {basisStats.count}{' '}
            samples.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Tape</h2>
        {(tape.session.state === 'pre-market' || tape.session.state === 'after-hours') && (
          <p className="geo-note" style={{ marginTop: 0 }}>
            Basis is against a live {tape.session.state === 'pre-market' ? 'pre-market' : 'after-hours'} print, not the
            regular-session close — extended-hours trading is thinner, so this can move more than the regular-session
            number would.
          </p>
        )}
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
            {activeRow?.nextEarningsDate != null && daysUntil(activeRow.nextEarningsDate) <= EARNINGS_CAVEAT_WINDOW_DAYS && daysUntil(activeRow.nextEarningsDate) >= 0 && (
              <p className="geo-note">
                {activeStock.cashTicker} reports earnings in {daysUntil(activeRow.nextEarningsDate)} day
                {daysUntil(activeRow.nextEarningsDate) === 1 ? '' : 's'} — expect wider spreads and more volatility
                than this estimate reflects.
              </p>
            )}

            {arbEdge && (
              <>
                <h3 className="depth-heading">Cash-and-carry edge</h3>
                <div className="result-hero">
                  <div>
                    <div className="label">Annualized, held to reopen</div>
                    <div className={`value ${arbEdge.annualizedPct != null && arbEdge.annualizedPct >= 0 ? 'basis-pos' : 'basis-neg'}`}>
                      {arbEdge.annualizedPct == null ? '—' : `${arbEdge.annualizedPct >= 0 ? '+' : ''}${arbEdge.annualizedPct.toFixed(0)}%`}
                    </div>
                  </div>
                </div>
                <div className="result-grid">
                  <div className="result-cell">
                    <div className="label">Gross basis edge</div>
                    <div className={`value ${arbEdge.grossEdgeBp >= 0 ? 'basis-pos' : 'basis-neg'}`}>{bp(arbEdge.grossEdgeBp)}</div>
                  </div>
                  <div className="result-cell">
                    <div className="label">Pool fee</div>
                    <div className="value">-{arbEdge.feeBp.toFixed(1)} bp</div>
                  </div>
                  <div className="result-cell">
                    <div className="label">Price impact</div>
                    <div className="value">-{arbEdge.impactBp.toFixed(1)} bp</div>
                  </div>
                  <div className="result-cell">
                    <div className="label">Est. gas ({usd(GAS_ESTIMATE_USD)})</div>
                    <div className="value">-{arbEdge.gasBp.toFixed(1)} bp</div>
                  </div>
                  <div className="result-cell">
                    <div className="label">Net edge</div>
                    <div className={`value ${arbEdge.netEdgeBp >= 0 ? 'basis-pos' : 'basis-neg'}`}>{bp(arbEdge.netEdgeBp)}</div>
                  </div>
                </div>
                <p className="geo-note">
                  Assumes buying {activeStock.symbol} now at this size and full convergence to the current cash
                  reference by reopen — not guaranteed, and this app can only go long (no short leg), so a negative
                  gross basis edge (on-chain priced above cash) has no offsetting trade here. Gas is a flat estimate
                  for a typical Base swap, not simulated for this specific trade.
                </p>
              </>
            )}

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

            {depth && depth.symbol === symbol && (
              <>
                <h3 className="depth-heading">Liquidity depth</h3>
                <DepthChart buckets={depth.buckets} currentPriceUsd={depth.currentPriceUsd} />
                <p className="geo-note">
                  Active on-chain liquidity by price, read directly from the pool&apos;s tick data — taller bars are
                  where support/resistance walls actually sit. Dashed line marks the current price.
                </p>
              </>
            )}
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
              {quote && (
                <button type="button" className="copy-trade-btn" onClick={copyAmount}>
                  {amountCopied ? 'Copied ✓' : `Copy ${usd(quote.usdcIn, 0)}`}
                </button>
              )}
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
        <p className="geo-note contract-info">
          Token{' '}
          <a href={`https://basescan.org/address/${activeStock.tokenAddress}`} target="_blank" rel="noopener noreferrer">
            {truncateAddr(activeStock.tokenAddress)} ↗
          </a>
          {' · '}Pool{' '}
          <a href={`https://basescan.org/address/${activeStock.pool.address}`} target="_blank" rel="noopener noreferrer">
            {truncateAddr(activeStock.pool.address)} ↗
          </a>
          {' — verified on-chain, see README for the full check.'}
        </p>
        {activeRow?.multiplier != null && activeRow.multiplier !== 1 && (
          <p className="geo-note">
            1 {activeStock.symbol} currently redeems for {activeRow.multiplier.toFixed(4)} shares — reflects a past
            split or reinvested dividend (B20&apos;s <code>multiplier()</code>, read live on every quote).
          </p>
        )}
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
