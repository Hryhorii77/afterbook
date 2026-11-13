'use client';

// "Describe a basket" on /plan (2026-11-13). The form goes to /api/agent/brief, where the code picks
// every stock, weight and amount (lib/agent/brief.ts) and Claude only explains it. The basket is bought
// through /build's normal basket buy (BasketBuyPanel), behind the same region gate and eligibility box;
// nothing is sent without the person's signature in their own wallet.
import { useRef, useState } from 'react';
import Link from 'next/link';
import type { GeoInfo } from '@/lib/server/geo';
import type { Brief } from '@/lib/agent/brief';
import { BRIEF_LIMITS, EARNINGS_OPTIONS, PLAN_LIMITS } from '@/lib/agent/limits';
import { PROFILES, SECTORS, THEMES, type Sector } from '@/lib/stocks/sectors';
import { getStock } from '@/lib/stocks/tokens';
import { formatSpec } from '@/lib/build/customBasket';
import { bpPct, formatNextOpen, usd } from '@/lib/format';
import { BasketBuyPanel } from '../baskets/BasketBuyPanel';
import { SymbolTile } from '../ui/SymbolTile';

/** Sectors some tracked stock is in: the only ones worth offering to leave out. */
const USED_SECTORS = SECTORS.filter((s) => Object.values(PROFILES).some((p) => p.sector === s));
const SPREADS = [2, 3, 4].filter((n) => n >= BRIEF_LIMITS.minStocks && n <= BRIEF_LIMITS.maxStocks);
const pct = (bp: number) => `${(bp / 100).toFixed(2)}%`;
const ticker = (sym: string) => getStock(sym)?.cashTicker ?? sym;
const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

interface Result {
  brief: Brief;
  explanation: string;
  explainedBy: 'claude' | 'fixed';
}

export function BriefClient({ geo }: { geo: GeoInfo }) {
  const [theme, setTheme] = useState<string>('Any');
  const [exclude, setExclude] = useState<Sector[]>([]);
  const [minStocks, setMinStocks] = useState(3);
  const [budget, setBudget] = useState('1000');
  const [cashPct, setCashPct] = useState('0');
  const [premiumPct, setPremiumPct] = useState('0.5');
  const [costPct, setCostPct] = useState('0.3');
  const [earningsDays, setEarningsDays] = useState(2);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [eligible, setEligible] = useState(false);
  const [buying, setBuying] = useState(false);
  /** A buy was started for this result: a new one would clear its progress, so the button says so. */
  const [ran, setRan] = useState(false);
  const resultRef = useRef<HTMLElement>(null);

  const toggleSector = (s: Sector) => setExclude((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));

  /** The last brief sent: "Spread over at least N?" reruns that brief, not whatever the form says now. */
  const lastBody = useRef<Record<string, unknown> | null>(null);

  const run = async (spread = minStocks, from: Record<string, unknown> | null = null) => {
    setBusy(true);
    setError(null);
    try {
      const body = from
        ? { ...from, minStocks: spread }
        : {
          theme,
          exclude,
          minStocks: spread,
          budgetUsd: Number(budget),
          cashPct: Number(cashPct || 0),
          // Rounded: Number('0.29') * 100 is 28.999…
          maxPremiumBp: Math.round(Number(premiumPct) * 10_000) / 100,
          maxCostBp: Math.round(Number(costPct) * 10_000) / 100,
          earningsDays,
          note,
        };
      const res = await fetch('/api/agent/brief', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => null);
      if (!res.ok || !out?.brief) {
        setError(out?.error ? `Couldn’t build the basket: ${out.error}.` : 'Couldn’t build the basket just now. Try again in a moment.');
        return;
      }
      lastBody.current = body;
      setResult(out);
      setRan(false);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch {
      setError('Couldn’t build the basket just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void run();
  };

  const brief = result?.brief;
  const closed = brief?.session.state.startsWith('closed');
  // Right after a deploy the depth history is minutes long, not 3 hours: say so rather than claim 3 hours.
  const short = (since: number | null | undefined) => !!brief && since != null && brief.createdAt - since < 2.75 * 3_600_000;
  const shortHistory = short(brief?.readingsSinceMs);
  const stocks = (brief?.basket ?? []).map((l) => ({ symbol: l.symbol, decimals: getStock(l.symbol)?.decimals ?? 8 }));

  return (
    <>
      <form className="panel plan-form" onSubmit={submit}>
        <h2>The basket you want</h2>
        <fieldset className="plan-field">
          <legend>Theme</legend>
          <div className="plan-chips" role="group" aria-label="Theme">
            {['Any', ...THEMES].map((t) => (
              <button key={t} type="button" className={theme === t ? 'preset-btn preset-btn-active' : 'preset-btn'} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t}
              </button>
            ))}
          </div>
          <p className="plan-hint">Themes are Afterbook’s own fixed labels; the stocks in each are listed with the result.</p>
        </fieldset>
        <fieldset className="plan-field">
          <legend>Leave out</legend>
          <div className="plan-chips" role="group" aria-label="Sectors to leave out">
            {USED_SECTORS.map((s) => (
              <button key={s} type="button" className={exclude.includes(s) ? 'preset-btn preset-btn-active' : 'preset-btn'} aria-pressed={exclude.includes(s)} onClick={() => toggleSector(s)}>
                {s}
              </button>
            ))}
          </div>
          <p className="plan-hint">Standard (GICS) sectors. Tap any you don’t want in the basket.</p>
        </fieldset>

        <div className="plan-grid">
          <label className="plan-field">
            <span>Spread over at least</span>
            <select value={minStocks} onChange={(e) => setMinStocks(Number(e.target.value))}>
              {SPREADS.map((n) => (
                <option key={n} value={n}>
                  {n} stocks (about {Math.round(100 / n)}% in each)
                </option>
              ))}
            </select>
            <small>About equal amounts in each, at most {BRIEF_LIMITS.maxStocks} stocks.</small>
          </label>
          <label className="plan-field">
            <span>Budget (USDC)</span>
            <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>Up to {usd(BRIEF_LIMITS.maxBudgetUsd, 0)}, the most one basket buy can be.</small>
          </label>
          <label className="plan-field">
            <span>Keep as cash (%)</span>
            <input inputMode="decimal" value={cashPct} onChange={(e) => setCashPct(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>Stays in your wallet as USDC. Up to {BRIEF_LIMITS.maxCashPct}%.</small>
          </label>
          <label className="plan-field">
            <span>Most above the real stock’s price (%)</span>
            <input inputMode="decimal" value={premiumPct} onChange={(e) => setPremiumPct(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>A token priced further above its stock is left out.</small>
          </label>
          <label className="plan-field">
            <span>Most to pay to trade (%)</span>
            <input inputMode="decimal" value={costPct} onChange={(e) => setCostPct(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>Price impact plus the pool fee; a stock is bought for less to fit.</small>
          </label>
          <label className="plan-field">
            <span>Earnings</span>
            <select value={earningsDays} onChange={(e) => setEarningsDays(Number(e.target.value))}>
              {EARNINGS_OPTIONS.map((o) => (
                <option key={o.days} value={o.days}>
                  {o.label}
                </option>
              ))}
            </select>
            <small>Prices often jump on an earnings report.</small>
          </label>
        </div>
        <label className="plan-field">
          <span>Anything else (optional)</span>
          <textarea rows={2} maxLength={PLAN_LIMITS.maxNoteChars} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Something steady I won’t need to watch" />
          <small>Claude reads this when explaining; it never picks a stock or changes an amount.</small>
        </label>
        <div className="basket-row">
          <button type="submit" className="btn" disabled={busy || buying}>
            {busy ? 'Checking…' : ran ? 'Build a new basket (clears the buy below)' : 'Build the basket'}
          </button>
        </div>
        {ran && !buying && (
          <p className="plan-hint">Building a new basket clears the buy below. Anything it left approved for the router is listed on Portfolio, with a Revoke button.</p>
        )}
        {error && <p className="geo-note geo-note-blocked">{error}</p>}
      </form>

      {result && brief && (
        <section className="panel plan-result" ref={resultRef} aria-live="polite">
          <h2>{brief.picks ? 'Your basket' : 'No basket this time'}</h2>
          <p className="plan-meta">
            {brief.picks ? `${usd(brief.investedUsd, 0)} in ${brief.picks.length} stocks · ${usd(brief.cashUsd, 2)} kept as cash` : `${usd(brief.cashUsd, 0)} stays as cash`} ·{' '}
            {brief.session.label}
            {closed && ` · cash reopens ${formatNextOpen(brief.session.nextOpenIso)}`}
          </p>
          <p className="plan-explanation">{result.explanation}</p>
          <p className="plan-hint">{result.explainedBy === 'claude' ? 'Explained by Claude from the numbers below.' : 'Explained in fixed words (Claude wasn’t used for this one).'}</p>

          <h3 className="brief-subhead">How the stocks were narrowed</h3>
          <ol className="brief-steps">
            {brief.steps.map((s) => (
              <li key={s.label}>
                <strong>{s.symbols.length}</strong> {s.label}
                {shortHistory && s.label.includes('every reading') && <span className="plan-hint"> (readings only since {time(brief.readingsSinceMs!)})</span>}
                {s.symbols.length > 0 && s.symbols.length <= 12 && <span className="plan-hint"> ({s.symbols.map(ticker).join(', ')})</span>}
              </li>
            ))}
          </ol>
          {brief.shortfall && result.explainedBy === 'claude' && <p className="geo-note">{brief.shortfall}</p>}
          {brief.suggestion && (
            <div className="basket-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy || buying}
                onClick={() => {
                  setMinStocks(brief.suggestion!.minStocks);
                  void run(brief.suggestion!.minStocks, lastBody.current);
                }}
              >
                {brief.suggestion.text}
              </button>
            </div>
          )}

          {brief.picks && (
            <ul className="plan-legs">
              {brief.picks.map((p) => {
                const profile = PROFILES[p.symbol];
                return (
                  <li key={p.symbol} className="plan-leg plan-leg-buy">
                    <div className="plan-leg-head">
                      <SymbolTile cashTicker={ticker(p.symbol)} />
                      <div className="plan-leg-name">
                        <strong>
                          {p.name} ({ticker(p.symbol)})
                        </strong>
                        <span className="brief-sector">
                          {profile?.sector} · {profile?.themes.join(', ')}
                        </span>
                      </div>
                      <span className="plan-verdict">{p.weightPct}%</span>
                    </div>
                    <dl className="plan-figures">
                      <div>
                        <dt>Buy</dt>
                        <dd>{usd(p.usd, 2)}</dd>
                      </div>
                      <div>
                        <dt>Gap vs cash {p.gapAgainst}</dt>
                        <dd>{bpPct(p.gapBp)}</dd>
                      </div>
                      <div>
                        <dt>Cost to trade</dt>
                        <dd>{pct(p.costBp)}</dd>
                      </div>
                      <div>
                        <dt>{short(p.depthSinceMs) ? `Pool, lowest since ${time(p.depthSinceMs!)}` : 'Pool, lowest in 3 h'}</dt>
                        <dd>{usd(p.depthUsd, 0)}</dd>
                      </div>
                    </dl>
                    <ul className="plan-reasons">
                      {profile?.note && <li>{profile.note}</li>}
                      <li>
                        Pool depth: the lowest Afterbook read {short(p.depthSinceMs) ? `since ${time(p.depthSinceMs!)}` : 'in the last 3 hours'}, newest reading {time(p.depthAsOfMs)}. Prices: the pool and the cash market, read just now.
                      </li>
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}

          {brief.picks && brief.assumptions.length > 0 && (
            <>
              <h3 className="brief-subhead">Assumptions</h3>
              <ul className="plan-reasons">
                {brief.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          )}

          {brief.dropped.length > 0 && (
            <details className="brief-dropped">
              <summary>
                Why {brief.picks ? 'the other' : 'the'} {brief.dropped.length === 1 ? 'stock was' : `${brief.dropped.length} stocks were`} left out
              </summary>
              <ul className="plan-reasons">
                {brief.dropped.map((d) => (
                  <li key={d.symbol}>
                    <strong>{ticker(d.symbol)}</strong>: {d.why}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {brief.basket && (
            <div className="plan-swap">
              <h3>Review &amp; buy the basket</h3>
              <p className="geo-note">
                One approval of exactly the total, then one swap per stock, each rebuilt and checked before you sign. The box starts at the basket’s total, which splits into
                the amounts above; if you change it, the split follows the same weights. What you type in the box is what you buy.{' '}
                <Link
                  // Explicit weights unless all equal: /build would re-split 33/34/33 as 34/33/33 (review, 2026-11-13).
                  href={`/build/${brief.basket.every((l) => l.weightPct === brief.basket![0].weightPct) ? formatSpec(brief.basket) : brief.basket.map((l) => `${l.symbol}-${l.weightPct}`).join('_')}`}
                  className="emph-link"
                >
                  Open this basket on its own page
                </Link>
              </p>
              {geo.nonUs === true ? (
                <>
                  <label className="eligibility">
                    <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} disabled={buying || ran} />
                    I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
                  </label>
                  {eligible ? (
                    <BasketBuyPanel
                      key={`${brief.createdAt}`}
                      legs={brief.basket}
                      stocks={stocks} defaultUsd={brief.investedUsd}
                      onBusy={(b) => {
                        setBuying(b);
                        if (b) setRan(true);
                      }}
                    />
                  ) : (
                    <p className="geo-note">Tick the box above to review the basket.</p>
                  )}
                </>
              ) : (
                <p className="geo-note geo-note-blocked">
                  {geo.country === 'US'
                    ? "Trading is off in the United States: Coinbase's stock tokens aren't offered there. The basket itself still works."
                    : "Trading is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). The basket itself still works."}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
