'use client';

// The trade plan page (/plan, owner 2026-11-08). The form goes to /api/agent/plan, which decides and
// sizes every buy in code (lib/agent/plan.ts) and has Claude explain it. A buy opens the normal swap
// panel with that amount, behind the same region and eligibility checks as everywhere else; nothing is
// sent without the person's signature. Past plans are kept in this browser only (owner choice).
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { TapeResult } from '@/lib/market/tape';
import type { GeoInfo } from '@/lib/server/geo';
import type { Plan, PlanLeg } from '@/lib/agent/plan';
import { isLoggedPlan, type LoggedPlan } from '@/lib/agent/planLog';
import { EARNINGS_OPTIONS, PLAN_LIMITS } from '@/lib/agent/limits';
import { getStock } from '@/lib/stocks/tokens';
import { TAPE_MAIN_DEPTH_USD } from '@/lib/market/liquidity';
import { cleanNumberInput, readNumberFields } from '@/lib/agent/formFields';
import { bpPct, formatNextOpen, usd } from '@/lib/format';
import { SwapPanel } from '../swap/SwapPanel';
import { SymbolTile } from '../ui/SymbolTile';
import { BriefClient } from './BriefClient';

const LOG_KEY = 'afterbook-plans';
const LOG_MAX = 20;


function readLog(): LoggedPlan[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    // Keep good entries, at distinct times (they are the list's keys).
    const seen = new Set<number>();
    return list.filter((p): p is LoggedPlan => isLoggedPlan(p) && !seen.has(p.at) && !!seen.add(p.at)).slice(0, LOG_MAX);
  } catch {
    return [];
  }
}

function writeLog(list: LoggedPlan[]) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, LOG_MAX)));
  } catch {
    // private window or storage blocked: the log is a convenience
  }
}

const VERDICT_LABEL: Record<PlanLeg['verdict'], string> = { buy: 'Passes your limits', wait: 'Wait', skip: 'Skip' };


export function PlanClient({ initialTape, geo }: { initialTape: TapeResult; geo: GeoInfo }) {
  const [tape, setTape] = useState(initialTape);
  const rows = useMemo(
    () => [...tape.rows].filter((r) => (r.depthUsd ?? 0) >= TAPE_MAIN_DEPTH_USD).sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0)),
    [tape.rows],
  );

  const [picked, setPicked] = useState<string[]>([]);
  const [budget, setBudget] = useState('1000');
  const [premiumPct, setPremiumPct] = useState('0.5');
  const [costPct, setCostPct] = useState('0.3');
  const [earningsDays, setEarningsDays] = useState(2);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ plan: Plan; explanation: string; explainedBy: 'claude' | 'fixed' } | null>(null);
  const [selected, setSelected] = useState<PlanLeg | null>(null);
  const [eligible, setEligible] = useState(false);
  const [log, setLog] = useState<LoggedPlan[]>([]);
  const [mode, setMode] = useState<'pick' | 'brief'>('pick');
  const resultRef = useRef<HTMLElement>(null);
  const swapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLog(readLog()), []);

  // The log's "since then" column needs live prices: the same 20 s tape refresh as the other pages.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/tape');
        if (!res.ok) return;
        const next = (await res.json()) as TapeResult;
        if (alive && Array.isArray(next.rows) && next.rows.length > 0) setTape(next);
      } catch {
        // keep the last tape
      }
    };
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const toggle = (sym: string) =>
    setPicked((p) => (p.includes(sym) ? p.filter((s) => s !== sym) : p.length >= PLAN_LIMITS.maxSymbols ? p : [...p, sym]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const read = readNumberFields({
      budget: [budget, 'the budget'],
      premium: [premiumPct, 'Most I’ll pay over the real stock'],
      cost: [costPct, 'Most I’ll pay to trade'],
    });
    if ('error' in read) {
      setError(`Check the form: ${read.error}.`);
      (document.querySelector(`[name="plan-${read.field}"]`) as HTMLInputElement | null)?.focus();
      return;
    }
    setBusy(true);
    setSelected(null);
    try {
      const res = await fetch('/api/agent/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbols: picked,
          budgetUsd: read.values.budget,
          maxPremiumBp: Math.round(read.values.premium * 10_000) / 100,
          maxCostBp: Math.round(read.values.cost * 10_000) / 100,
          earningsDays,
          note,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.plan) {
        setError(body?.error ? `Couldn’t make the plan: ${body.error}.` : 'Couldn’t make the plan just now. Try again in a moment.');
        return;
      }
      setResult(body);
      const entry: LoggedPlan = {
        at: body.plan.createdAt,
        budgetUsd: body.plan.budgetUsd,
        explainedBy: body.explainedBy,
        legs: (body.plan as Plan).legs.map((l) => ({ symbol: l.symbol, verdict: l.verdict, usd: l.usd, priceUsd: l.priceUsd })),
      };
      const next = [entry, ...readLog()].slice(0, LOG_MAX);
      writeLog(next);
      setLog(next);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch {
      setError('Couldn’t make the plan just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const review = (leg: PlanLeg) => {
    setSelected(leg);
    requestAnimationFrame(() => swapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const priceNow = (sym: string) => tape.rows.find((r) => r.symbol === sym)?.onchainMidUsd ?? null;
  const selectedStock = selected ? getStock(selected.symbol) : undefined;
  const closed = tape.session.state.startsWith('closed');

  return (
    <main className="plan-page">
      <header className="top">
        <h1>Trade plan</h1>
      </header>
      <p className="plan-intro">
        Tell it what you’d like to buy and your limits. Afterbook checks each stock’s gap to the real stock, upcoming earnings, pool
        depth and what the trade would cost, then Claude explains the result. Nothing is bought until you review a buy and sign it in your
        own wallet. This is a tool for your own decisions, not financial advice.
      </p>

      <div className="carry-direction-toggle swap-side-toggle plan-mode" role="tablist" aria-label="How to choose stocks">
        {(
          [
            ['pick', 'Pick stocks'],
            ['brief', 'Describe a basket'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Both stay mounted (hidden, not removed), so a buy in progress in either is never lost. */}
      <div hidden={mode !== 'brief'}>
        <BriefClient geo={geo} />
      </div>
      <div hidden={mode !== 'pick'} className="plan-pick">

      <form className="panel plan-form" onSubmit={submit}>
        <h2>What you want</h2>
        <fieldset className="plan-field">
          <legend>Stocks</legend>
          <div className="plan-chips" role="group" aria-label="Stocks">
            <button type="button" className={picked.length === 0 ? 'preset-btn preset-btn-active' : 'preset-btn'} aria-pressed={picked.length === 0} onClick={() => setPicked([])}>
              The {PLAN_LIMITS.anyCount} deepest
            </button>
            {rows.map((r) => (
              <button
                key={r.symbol}
                type="button"
                className={picked.includes(r.symbol) ? 'preset-btn preset-btn-active' : 'preset-btn'}
                aria-pressed={picked.includes(r.symbol)}
                onClick={() => toggle(r.symbol)}
              >
                {r.cashTicker}
              </button>
            ))}
          </div>
          <p className="plan-hint">Up to {PLAN_LIMITS.maxSymbols}. Only pools of at least {usd(TAPE_MAIN_DEPTH_USD, 0)} are listed.</p>
        </fieldset>

        <div className="plan-grid">
          <label className="plan-field">
            <span>Budget (USDC)</span>
            <input inputMode="decimal" name="plan-budget" value={budget} onChange={(e) => setBudget(cleanNumberInput(e.target.value))} aria-describedby="plan-budget-hint" />
            <small id="plan-budget-hint">Split equally; one swap is at most $25,000 and 10% of its pool.</small>
          </label>
          <label className="plan-field">
            <span>Most I’ll pay over the real stock (%)</span>
            <input inputMode="decimal" name="plan-premium" value={premiumPct} onChange={(e) => setPremiumPct(cleanNumberInput(e.target.value))} />
            <small>A stock whose token trades further above its cash price waits.</small>
          </label>
          <label className="plan-field">
            <span>Most I’ll pay to trade (%)</span>
            <input inputMode="decimal" name="plan-cost" value={costPct} onChange={(e) => setCostPct(cleanNumberInput(e.target.value))} />
            <small>Price impact plus the pool fee; bigger buys are sized down to fit.</small>
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
          <textarea
            rows={2}
            maxLength={PLAN_LIMITS.maxNoteChars}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. I’m building a long-term position and don’t mind waiting"
          />
          <small>Claude reads this when explaining; it never changes the numbers or the limits.</small>
        </label>
        <div className="basket-row">
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Checking…' : 'Make the plan'}
          </button>
        </div>
        {error && <p className="geo-note geo-note-blocked" role="alert">{error}</p>}
      </form>

      {result && (
        <section className="panel plan-result" ref={resultRef} aria-live="polite">
          <h2>The plan</h2>
          <p className="plan-meta">
            {usd(result.plan.plannedUsd, 0)} of {usd(result.plan.budgetUsd, 0)} planned · {result.plan.session.label}
            {closed && ` · cash reopens ${formatNextOpen(result.plan.session.nextOpenIso)}`}
          </p>
          <p className="plan-explanation">{result.explanation}</p>
          <p className="plan-hint">{result.explainedBy === 'claude' ? 'Explained by Claude from the numbers below.' : 'Explained in fixed words (Claude wasn’t used for this one).'}</p>
          <ul className="plan-legs">
            {result.plan.legs.map((leg) => {
              const stock = getStock(leg.symbol);
              return (
                <li key={leg.symbol} className={`plan-leg plan-leg-${leg.verdict}`}>
                  <div className="plan-leg-head">
                    <SymbolTile cashTicker={stock?.cashTicker ?? leg.symbol} />
                    <div className="plan-leg-name">
                      <strong>{leg.symbol}</strong>
                      <span>{leg.name}</span>
                    </div>
                    <span className="plan-verdict">{VERDICT_LABEL[leg.verdict]}</span>
                  </div>
                  <dl className="plan-figures">
                    <div>
                      <dt>Gap vs cash {leg.gapAgainst}</dt>
                      <dd>{bpPct(leg.gapBp)}</dd>
                    </div>
                    <div>
                      <dt>Onchain price</dt>
                      <dd>{usd(leg.priceUsd)}</dd>
                    </div>
                    {leg.verdict === 'buy' && (
                      <>
                        <div>
                          <dt>Buy</dt>
                          <dd>{usd(leg.usd ?? 0, 0)}</dd>
                        </div>
                        <div>
                          <dt>Cost to trade</dt>
                          <dd>{(leg.costBp ?? 0).toFixed(1)} bp</dd>
                        </div>
                      </>
                    )}
                  </dl>
                  <ul className="plan-reasons">
                    {leg.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  {leg.verdict === 'buy' && (
                    <div className="basket-row">
                      <button type="button" className="btn btn-secondary" onClick={() => review(leg)}>
                        Review {usd(leg.usd ?? 0, 0)} of {leg.symbol}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {selected && selectedStock && (
            <div className="plan-swap" ref={swapRef}>
              <h3>
                {selected.symbol} · the plan’s amount: {usd(selected.usd ?? 0, 0)}
              </h3>
              <p className="geo-note">
                The swap below gets a fresh quote and runs the usual checks. It starts at the plan’s amount; what you type in the box is what you buy. If needed, your wallet
                asks you to approve exactly the amount you review, then the swap.
              </p>
              {geo.nonUs === true ? (
                <>
                  <label className="eligibility">
                    <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
                    I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
                  </label>
                  {eligible ? (
                    <SwapPanel key={`${selected.symbol}-${selected.usd}`} stock={selectedStock} defaultUsd={selected.usd} source="plan" />
                  ) : (
                    <p className="geo-note">Tick the box above to review the buy.</p>
                  )}
                </>
              ) : (
                <p className="geo-note geo-note-blocked">
                  {geo.country === 'US'
                    ? "Trading is off in the United States: Coinbase's stock tokens aren't offered there. The plan itself still works."
                    : "Trading is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). The plan itself still works."}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      </div>

      {log.length > 0 && (
        <section className="panel plan-log">
          <h2>Your past plans</h2>
          <p className="plan-hint">
            Kept in this browser only. “Since then” is how the onchain price moved after each plan: what a buy at that price would be up or
            down now, before costs. Past moves say nothing about the next ones.
          </p>
          <ul className="plan-log-list">
            {log.map((p) => {
              const buys = p.legs.filter((l) => l.verdict === 'buy');
              return (
                <li key={p.at}>
                  <span className="plan-log-date">
                    {new Date(p.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {buys.length === 0 ? (
                    <span className="plan-hint">No buy passed ({p.legs.map((l) => l.symbol).join(', ')})</span>
                  ) : (
                    <span className="plan-log-legs">
                      {buys.map((l) => {
                        const now = priceNow(l.symbol);
                        const movePct = now != null && l.priceUsd ? ((now - l.priceUsd) / l.priceUsd) * 100 : null;
                        return (
                          <span key={l.symbol} className="plan-log-leg">
                            {l.symbol} {usd(l.usd ?? 0, 0)} ·{' '}
                            <span className={movePct == null ? '' : movePct >= 0 ? 'basis-pos' : 'basis-neg'}>
                              {movePct == null ? '—' : `${movePct >= 0 ? '+' : ''}${movePct.toFixed(2)}%`}
                            </span>
                          </span>
                        );
                      })}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="basket-row">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                writeLog([]);
                setLog([]);
              }}
            >
              Clear the log
            </button>
          </div>
        </section>
      )}

      <p className="geo-note">
        <Link href="/rules" className="page-link">
          Buy on a schedule with stock rules<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
