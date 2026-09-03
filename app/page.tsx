'use client';

import { useEffect, useState } from 'react';
import { STOCKS, aerodromeSwapUrl } from '@/lib/tokens';

interface TapeRow {
  symbol: string;
  cashTicker: string;
  name: string;
  cashLastUsd: number | null;
  cashStale: boolean;
  onchainMidUsd: number | null;
  basisBp: number | null;
}

interface SessionInfo {
  state: string;
  label: string;
  nyTime: string;
}

interface TapeResponse {
  rows: TapeRow[];
  fetchedAt: number;
  session: SessionInfo;
  error?: string;
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
}

const usd = (n: number | null, digits = 2) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

const bp = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)} bp`);

const shares = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

export default function Home() {
  const [tape, setTape] = useState<TapeResponse | null>(null);
  const [geo, setGeo] = useState<{ country: string | null; nonUs: boolean } | null>(null);
  const [eligibleChecked, setEligibleChecked] = useState(false);
  const [symbol, setSymbol] = useState(STOCKS[0].symbol);
  const [usdcInput, setUsdcInput] = useState('2500');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);

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
    fetchTape();
    const id = setInterval(fetchTape, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    fetch('/api/geo')
      .then((r) => r.json())
      .then(setGeo)
      .catch(() => setGeo({ country: null, nonUs: false }));
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

  const unlocked = geo?.nonUs === true && eligibleChecked;
  const activeStock = STOCKS.find((s) => s.symbol === symbol)!;

  return (
    <main>
      <header className="top">
        <div>
          <h1>Afterbook</h1>
          <p className="tagline">Cash close vs the Aero book, in shares. Execution stays on Aerodrome.</p>
        </div>
        {tape?.session && (
          <span className="clock-badge">
            <span className={`dot ${tape.session.state}`} />
            {tape.session.label} · {tape.session.nyTime} ET
          </span>
        )}
      </header>

      <section className="panel">
        <h2>Tape</h2>
        <table>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Cash last</th>
              <th>Aero mid</th>
              <th>Basis</th>
            </tr>
          </thead>
          <tbody>
            {(tape?.rows ?? STOCKS.map((s) => ({ symbol: s.symbol, cashTicker: s.cashTicker, name: s.name, cashLastUsd: null, cashStale: false, onchainMidUsd: null, basisBp: null }))).map((row) => (
              <tr key={row.symbol}>
                <td>
                  <span className="symbol">{row.symbol}</span>
                  <span className="symbol-name">{row.name}</span>
                </td>
                <td>
                  {usd(row.cashLastUsd)}
                  {row.cashStale && <span className="stale-tag">STALE</span>}
                </td>
                <td>{usd(row.onchainMidUsd)}</td>
                <td className={row.basisBp != null ? (row.basisBp >= 0 ? 'basis-pos' : 'basis-neg') : ''}>
                  {bp(row.basisBp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tape?.error && <p className="geo-note">{tape.error}</p>}
      </section>

      <section className="panel">
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
            <div className="result-grid">
              <div className="result-cell">
                <div className="label">Shares out</div>
                <div className="value">{shares(quote.sharesOut)}</div>
              </div>
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
            <p className="geo-note">
              Estimated from the pool&apos;s current on-chain price and in-range liquidity — not a firm quote.
              {quote.largeTradeCaveat && ' This size is large relative to in-range liquidity and may cross into a wider price range; the real fill on Aerodrome could differ from this estimate.'}
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
            <a className="btn" href={aerodromeSwapUrl(activeStock)} target="_blank" rel="noopener noreferrer">
              Open {activeStock.symbol} on Aerodrome
            </a>
          ) : (
            <button className="btn" disabled>
              Open {activeStock.symbol} on Aerodrome
            </button>
          )}
        </div>
        <p className="geo-note">
          {geo?.country
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
