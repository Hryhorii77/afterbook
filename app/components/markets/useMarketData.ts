// The Markets page's data: the tape (server-rendered, then polled), the trend lines, the calculator's
// quote and the per-stock reads. Each poll keeps the last good answer when a refresh fails.
import { useEffect, useRef, useState } from 'react';
import type { TapeResult } from '@/lib/market/tape';
import { splitByLiquidity } from '@/lib/market/liquidity';
import { bp } from '@/lib/format';
import type { TrendData } from '../Tape';
import type { ClosedPeriodStats, DepthResponse, EarningsMoveStats, EventLogEntry, HistorySample, OpenSnapStats, PriceSample, QuoteResponse } from './types';

/** The tape, polled every 20 s, plus a session-local log of the cash market closing. */
export function useTapePoll(initialTape: TapeResult) {
  const [tape, setTape] = useState<TapeResult>(initialTape);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const prevSessionStateRef = useRef(initialTape.session.state);

  // Initial tape already came from the server render — poll for refreshes
  // only, no redundant fetch on mount.
  useEffect(() => {
    let cancelled = false;
    const fetchTape = async () => {
      try {
        const res = await fetch('/api/tape');
        if (!res.ok) throw new Error(`tape ${res.status}`);
        const json: TapeResult = await res.json();
        if (cancelled) return;
        setTape(json);
        setRefreshFailed(false);

        // Precursor to real alerts (Phase 2) — a client-only, session-local
        // log of the one event we can detect for free: the cash market just
        // closed. Resets on reload by design; nothing here is persisted.
        const wasOpen = prevSessionStateRef.current === 'open';
        const nowClosed = json.session.state !== 'open';
        if (wasOpen && nowClosed) {
          const { liquid } = splitByLiquidity(json.rows);
          const parts = liquid.map((r) => `${r.cashTicker} ${bp(r.basisBp)}`).join(' ');
          setEventLog((log) => [{ ts: Date.now(), text: `Cash closed. ${parts}` }, ...log].slice(0, 20));
        }
        prevSessionStateRef.current = json.session.state;
      } catch {
        // keep showing last good tape, and say so
        if (!cancelled) setRefreshFailed(true);
      }
    };
    const id = setInterval(fetchTape, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { tape, refreshFailed, eventLog };
}

// On-chain price trend per symbol (up to 30 days) and the 24h change, for the
// tape's chart and 24h columns. Loaded once and refreshed every 5 min; cells
// show a dash until it arrives.
export function useTrend() {
  const [trend, setTrend] = useState<TrendData | null>(null);
  useEffect(() => {
    let off = false;
    const load = async () => {
      try {
        const res = await fetch('/api/sparklines');
        if (!res.ok) return;
        const json = (await res.json()) as TrendData;
        if (!off && json.series) setTrend(json);
      } catch {
        // Trend lines are decoration; the table works without them.
      }
    };
    void load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      off = true;
      clearInterval(id);
    };
  }, []);
  return trend;
}

/** The current time, ticking every 30 s (the carry calculator counts down to the open). */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** The trade calculator's quote for a USDC size, debounced on typing. */
export function useLotQuote(symbol: string, usdcInput: string) {
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
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
  return { quote, quoteError };
}

/** Per-stock reads: gap history, pool depth, price samples, earnings moves and the 30-day stats. */
export function useSymbolData(symbol: string, cashClosedAsOfMs: number) {
  const [history, setHistory] = useState<HistorySample[]>([]);
  const [depth, setDepth] = useState<DepthResponse | null>(null);
  const [priceHistory, setPriceHistory] = useState<PriceSample[]>([]);
  const [earningsStats, setEarningsStats] = useState<EarningsMoveStats | null>(null);
  const [basisStats, setBasisStats] = useState<ClosedPeriodStats | null>(null);
  const [openSnap, setOpenSnap] = useState<OpenSnapStats | null>(null);

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

  // Raw price samples for the range selector's live in-range-probability
  // recompute — fetched once per symbol (not per drag frame) so dragging
  // stays purely client-side math, no request-per-pixel.
  useEffect(() => {
    let cancelled = false;
    const fetchPriceHistory = async () => {
      try {
        const res = await fetch(`/api/price-history?symbol=${encodeURIComponent(symbol)}`);
        const json = await res.json();
        if (!cancelled) setPriceHistory(res.ok ? (json.samples ?? []) : []);
      } catch {
        // keep showing last known samples
      }
    };
    fetchPriceHistory();
    const id = setInterval(fetchPriceHistory, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol]);

  // Historical earnings-move stats grow at most once a day (the cron), so
  // this doesn't need frequent polling — fetch on symbol change only.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/earnings-history?symbol=${encodeURIComponent(symbol)}`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) setEarningsStats(json.stats ?? null);
      })
      .catch(() => {
        // keep showing last known stats
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // A 30-day aggregate barely moves minute to minute — fetch on symbol
  // change only, no polling interval needed.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/history/stats?symbol=${encodeURIComponent(symbol)}`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) {
          setBasisStats(json.stats ?? null);
          setOpenSnap(json.openSnap ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBasisStats(null);
          setOpenSnap(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return { history, depth, priceHistory, earningsStats, basisStats, openSnap };
}
