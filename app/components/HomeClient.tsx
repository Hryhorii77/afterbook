'use client';

import { useEffect, useState } from 'react';
import { STOCKS, aerodromeSwapUrl, aerodromeDepositUrl } from '@/lib/tokens';
import type { TapeResult } from '@/lib/tape';
import type { GeoInfo } from '@/lib/geo';
import { ImpactCurve } from './ImpactCurve';

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

const usd = (n: number | null, digits = 2) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

const bp = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)} bp`);

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

interface HomeClientProps {
  initialTape: TapeResult;
  initialGeo: GeoInfo;
}

export default function HomeClient({ initialTape, initialGeo }: HomeClientProps) {
  const [tape, setTape] = useState<TapeResult>(initialTape);
  const [geo] = useState<GeoInfo>(initialGeo);
  const [eligibleChecked, setEligibleChecked] = useState(false);
  const [symbol, setSymbol] = useState(STOCKS[0].symbol);
  const [usdcInput, setUsdcInput] = useState('2500');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
        const json = await res.json();
        if (!cancelled) setTape(json);
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

  const unlocked = geo.nonUs === true && eligibleChecked;
  const activeStock = STOCKS.find((s) => s.symbol === symbol)!;
  const cashColumnLabel = tape.session.state === 'open' ? 'Cash last' : 'Cash close';

  const selectSymbol = (sym: string) => {
    setSymbol(sym);
    document.getElementById('lot-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const cashClosedAsOfMs =
    tape.session.state !== 'open' ? Math.max(0, ...tape.rows.map((r) => r.cashAsOfMs ?? 0)) : 0;
  const showGapHero = tape.session.state !== 'open' && cashClosedAsOfMs > 0;

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
            {tape.rows.map((row) => (
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
        <h2>Tape</h2>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>{cashColumnLabel}</th>
              <th>Aero mid</th>
              <th>Basis</th>
              <th>Depth</th>
            </tr>
          </thead>
          <tbody>
            {tape.rows.map((row) => (
              <tr
                key={row.symbol}
                className={`tape-row-clickable${row.symbol === symbol ? ' tape-row-active' : ''}`}
                onClick={() => selectSymbol(row.symbol)}
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
                  {usdCompact(row.depthUsd)} · {sharesCompact(row.depthShares)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tape.error && <p className="geo-note">{tape.error}</p>}
      </section>

      <section className="panel" id="lot-lab">
        <h2>Lot Lab</h2>
        <div className="lot-lab-form">
          <div className="field">
            <label htmlFor="symbol-select">Stock</label>
            <select id="symbol-select" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {STOCKS.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol}
                </option>
              ))}
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

        {quoteError && <p className="geo-note">{quoteError}</p>}

        {quote && (
          <>
            <div className="result-hero">
              <div className="label">Shares out</div>
              <div className="value">{shares(quote.sharesOut)}</div>
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
          No wallet ever connects here; the button only opens Aerodrome&apos;s own app in a new tab.
        </p>
      </section>

      <footer>
        <p>
          Afterbook reads Aerodrome&apos;s on-chain pool state and public cash-market prices server-side, and never
          holds keys, requests approvals, or constructs swap calldata. All trading, lending, and liquidity actions
          happen on Aerodrome&apos;s own app.
        </p>
        <ul>
          <li>Allowlisted contracts only — four token addresses and four pool addresses, verified on-chain</li>
          <li>Server-side fetches; the browser only talks to this site&apos;s own /api routes</li>
          <li>No wallet connect, no seed phrase, no approvals, no custom router</li>
          <li>Official Aerodrome URLs only for every execution link</li>
        </ul>
        <p>MIT licensed.</p>
      </footer>
    </main>
  );
}
