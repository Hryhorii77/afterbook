'use client';

// Personal stock rules (/rules, owner 2026-11-11). A rule is "buy $X of a stock on a schedule, within my
// limits". When a run is due, the person checks it: /api/agent/rule-check runs the trade plan's own code
// for that one stock (lib/agent/plan.ts), and a run that passes opens the normal swap panel with its amount,
// behind the same region and eligibility checks as everywhere else. Nothing buys on its own and nothing
// is sent without the person's signature. Rules and history live in this browser only (owner choice),
// with an export/import file for moving or backing them up.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { usePublicClient } from 'wagmi';
import { base } from 'wagmi/chains';
import type { TapeResult } from '@/lib/market/tape';
import type { GeoInfo } from '@/lib/server/geo';
import type { PlanLeg } from '@/lib/agent/plan';
import {
  RULE_LIMITS,
  WEEKDAYS,
  cadenceText,
  cleanRules,
  cleanRuns,
  dayText,
  exportFile,
  importFile,
  localDayKey,
  ruleState,
  runBudget,
  spentUsd,
  type Cadence,
  type Rule,
  type RuleRun,
} from '@/lib/agent/rules';
import { getStock } from '@/lib/stocks/tokens';
import { TAPE_MAIN_DEPTH_USD } from '@/lib/market/liquidity';
import { bpPct, formatNextOpen, usd } from '@/lib/format';
import { SwapPanel } from '../swap/SwapPanel';
import { SymbolTile } from '../ui/SymbolTile';

const RULES_KEY = 'afterbook-rules';
const RUNS_KEY = 'afterbook-rule-runs';
const known = (s: string) => !!getStock(s);

function readStore(): { rules: Rule[]; runs: RuleRun[] } {
  try {
    const rules = cleanRules(JSON.parse(localStorage.getItem(RULES_KEY) ?? '[]'), known);
    return { rules, runs: cleanRuns(JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]'), liveIds(rules)) };
  } catch {
    return { rules: [], runs: [] };
  }
}

/** False when the browser refused to save (private window, storage blocked or full). */
function writeStore(rules: Rule[], runs: RuleRun[]): boolean {
  try {
    localStorage.setItem(RULES_KEY, JSON.stringify(rules));
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
    return true;
  } catch {
    return false;
  }
}

const liveIds = (rules: Rule[]) => new Set(rules.map((r) => r.id));

/** A pending buy whose transaction isn't found this long after it was sent can be marked as not gone
 *  through by hand (a dropped transaction); before that, or once found, only the receipt decides. */
const PENDING_GIVE_UP_MS = 30 * 60_000;

const newId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

const EARNINGS_OPTIONS = [
  { days: 0, label: 'Ignore earnings' },
  { days: 2, label: 'Pause within 2 days' },
  { days: 7, label: 'Pause within 7 days' },
];

const VERDICT_LABEL: Record<PlanLeg['verdict'], string> = { buy: 'Passes your limits', wait: 'Wait', skip: 'Skip' };

interface Check {
  ruleId: string;
  slot: string;
  leg: PlanLeg;
  session: { state: string; label: string; nextOpenIso: string };
  checkedAt: number;
  /** What the run may spend (the run's amount, cut to what's left of the cap): the swap refuses more. */
  budgetUsd: number;
}

/** A passed check opens the swap for this long; after it, or on a new day, or once the rule is paused,
 *  the page asks for a fresh check (the gap can move past the limit in the meantime). */
const CHECK_FRESH_MS = 15 * 60_000;

export function RulesClient({ initialTape, geo }: { initialTape: TapeResult; geo: GeoInfo }) {
  const rows = useMemo(
    () => [...initialTape.rows].filter((r) => (r.depthUsd ?? 0) >= TAPE_MAIN_DEPTH_USD).sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0)),
    [initialTape.rows],
  );

  const [loaded, setLoaded] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [runs, setRuns] = useState<RuleRun[]>([]);
  const [today, setToday] = useState('');
  const [now, setNow] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);

  // The form
  const [symbol, setSymbol] = useState(rows[0]?.symbol ?? '');
  const [amount, setAmount] = useState('50');
  const [kind, setKind] = useState<Cadence['kind']>('weekly');
  const [weekday, setWeekday] = useState(1);
  const [monthDay, setMonthDay] = useState(1);
  const [cap, setCap] = useState('');
  const [premiumPct, setPremiumPct] = useState('0.5');
  const [costPct, setCostPct] = useState('0.3');
  const [earningsDays, setEarningsDays] = useState(2);
  const [formError, setFormError] = useState<string | null>(null);

  // A due run being checked or bought
  const [checking, setChecking] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [eligible, setEligible] = useState(false);
  const [justBought, setJustBought] = useState<{ symbol: string; usd: number; hash: Hex } | null>(null);
  const [revertNote, setRevertNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const checkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const s = readStore();
    setRules(s.rules);
    setRuns(s.runs);
    setToday(localDayKey());
    setNow(Date.now());
    setLoaded(true);
    // Another tab changed the rules or runs: take its version (it may have bought a run this tab shows).
    const onStorage = (e: StorageEvent) => {
      if (e.key !== RULES_KEY && e.key !== RUNS_KEY && e.key !== null) return;
      const next = readStore();
      setRules(next.rules);
      setRuns(next.runs);
    };
    window.addEventListener('storage', onStorage);
    // Keep "today" right across midnight, and a check's age, while the page stays open.
    const id = setInterval(() => {
      setToday(localDayKey());
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(id);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const save = useCallback((nextRules: Rule[], nextRuns: RuleRun[]) => {
    setRules(nextRules);
    setRuns(nextRuns);
    setSaveFailed(!writeStore(nextRules, nextRuns));
  }, []);

  const addRun = useCallback(
    (run: RuleRun) => {
      // Read back first: another tab may have changed the store since this one loaded it.
      const s = readStore();
      const others = s.runs.filter((r) => !(r.ruleId === run.ruleId && r.slot === run.slot));
      save(s.rules, cleanRuns([run, ...others], liveIds(s.rules)));
    },
    [save],
  );

  const states = useMemo(() => new Map(rules.map((r) => [r.id, today ? ruleState(r, runs, today) : null])), [rules, runs, today]);
  const due = rules.filter((r) => states.get(r.id)?.kind === 'due');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const s = readStore();
    if (s.rules.length >= RULE_LIMITS.maxRules) return setFormError(`You can keep up to ${RULE_LIMITS.maxRules} rules. Delete one first.`);
    const runUsd = Number(amount);
    if (!Number.isFinite(runUsd) || runUsd < RULE_LIMITS.minRunUsd || runUsd > RULE_LIMITS.maxRunUsd) {
      return setFormError(`Each run must be between ${usd(RULE_LIMITS.minRunUsd, 0)} and ${usd(RULE_LIMITS.maxRunUsd, 0)}.`);
    }
    const capUsd = cap.trim() === '' ? null : Number(cap);
    if (capUsd !== null && (!Number.isFinite(capUsd) || capUsd < runUsd || capUsd > RULE_LIMITS.maxCapUsd)) {
      return setFormError(`The total cap must be at least one run (${usd(runUsd, 0)}) and at most ${usd(RULE_LIMITS.maxCapUsd, 0)}, or empty for no cap.`);
    }
    const maxPremiumBp = Math.round(Number(premiumPct) * 100);
    if (!Number.isFinite(maxPremiumBp) || premiumPct.trim() === '' || maxPremiumBp < 0 || maxPremiumBp > RULE_LIMITS.maxPremiumBp) {
      return setFormError(`The most over the real stock must be between 0% and ${RULE_LIMITS.maxPremiumBp / 100}%.`);
    }
    const maxCostBp = Math.round(Number(costPct) * 100);
    if (!Number.isFinite(maxCostBp) || maxCostBp < 1 || maxCostBp > RULE_LIMITS.maxCostBp) {
      return setFormError(`The most to trade must be between 0.01% and ${RULE_LIMITS.maxCostBp / 100}%.`);
    }
    if (!known(symbol)) return setFormError('Pick a stock.');
    const cadence: Cadence = kind === 'monthly' ? { kind, day: monthDay } : { kind, weekday };
    const rule: Rule = {
      id: newId(),
      symbol,
      usd: Math.floor(runUsd * 100) / 100,
      cadence,
      capUsd,
      maxPremiumBp,
      maxCostBp,
      earningsDays,
      paused: false,
      startKey: localDayKey(),
      createdAt: Date.now(),
    };
    save([...s.rules, rule], s.runs);
  };

  const runCheck = async (rule: Rule) => {
    const state = ruleState(rule, runs, today);
    if (state.kind !== 'due') return;
    setChecking(rule.id);
    setCheck(null);
    setJustBought(null);
    setRevertNote(null);
    setCheckError(null);
    try {
      const res = await fetch('/api/agent/rule-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: rule.symbol, usd: state.usd, maxPremiumBp: rule.maxPremiumBp, maxCostBp: rule.maxCostBp, earningsDays: rule.earningsDays }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.leg) {
        setCheckError(body?.error ? `Couldn’t check the run: ${body.error}.` : 'Couldn’t check the run just now. Try again in a moment.');
        return;
      }
      const checkedAt = Date.now();
      setNow(checkedAt);
      setCheck({ ruleId: rule.id, slot: state.slot, leg: body.leg, session: body.session, checkedAt, budgetUsd: state.usd });
      requestAnimationFrame(() => checkRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch {
      setCheckError('Couldn’t check the run just now. Try again in a moment.');
    } finally {
      setChecking(null);
    }
  };

  const skip = (rule: Rule, slot: string) => {
    const decided = check?.ruleId === rule.id && check.leg.verdict !== 'buy' ? (check.leg.decidedBy ?? check.leg.reasons[0]) : undefined;
    addRun({ ruleId: rule.id, symbol: rule.symbol, slot, at: Date.now(), outcome: 'skipped', reason: decided ? `Skipped: ${decided}` : 'You skipped it.' });
    if (check?.ruleId === rule.id) setCheck(null);
  };

  // One buy per run. The run is saved as pending the moment the wallet sends the swap (a closed tab then
  // can't make it look due again), becomes bought once mined, and the check closes so it can't be bought
  // twice; a mined revert puts the run back to due.
  const sent = (rule: Rule, slot: string) => (paid: number, hash: Hex) => {
    addRun({ ruleId: rule.id, symbol: rule.symbol, slot, at: Date.now(), outcome: 'pending', usd: Math.round(paid * 100) / 100, hash });
  };
  const bought = (rule: Rule, slot: string) => (paid: number, hash: Hex) => {
    addRun({ ruleId: rule.id, symbol: rule.symbol, slot, at: Date.now(), outcome: 'bought', usd: Math.round(paid * 100) / 100, hash });
    setCheck(null);
    setEligible(false);
    setJustBought({ symbol: rule.symbol, usd: Math.round(paid * 100) / 100, hash });
  };
  const dropRun = useCallback(
    (ruleId: string, slot: string) => {
      const s = readStore();
      save(s.rules, s.runs.filter((r) => !(r.ruleId === ruleId && r.slot === slot)));
    },
    [save],
  );
  const reverted = (rule: Rule, slot: string) => () => {
    dropRun(rule.id, slot);
    setCheck(null);
    setEligible(false);
    setRevertNote(`The ${rule.symbol} buy reverted onchain or was cancelled in your wallet, so nothing was bought. The run is due again; check it again to retry.`);
  };

  // Settle pending buys from the chain:
  // - a receipt: mined → bought; mined and reverted → the run is due again;
  // - no receipt, but the node knows the transaction: remember its sender and nonce;
  // - otherwise it stays pending, counted toward the cap, and any RPC error leaves it so. A hash the node
  //   doesn't know, or whose nonce another transaction used (a replacement: a sped-up buy lands under a
  //   new hash), can be marked as not gone through by hand 30 minutes on, after checking the wallet.
  const publicClient = usePublicClient({ chainId: base.id });
  const [unknownToNode, setUnknownToNode] = useState<Set<string>>(new Set());
  const pendingKey = runs.filter((r) => r.outcome === 'pending').map((r) => r.hash).join(',');
  useEffect(() => {
    if (!publicClient || !pendingKey) return;
    let alive = true;
    void (async () => {
      const unknown = new Set<string>();
      // Write only if the stored run is still this pending hash: the tab's own `bought` (or another tab)
      // may have settled it while these reads were in flight.
      const stillPending = (run: RuleRun) =>
        readStore().runs.some((r) => r.ruleId === run.ruleId && r.slot === run.slot && r.outcome === 'pending' && r.hash === run.hash);
      for (const run of readStore().runs.filter((r) => r.outcome === 'pending' && r.hash)) {
        const hash = run.hash as Hex;
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash });
          if (!alive) return;
          if (!stillPending(run)) continue;
          if (receipt.status === 'success') addRun({ ...run, outcome: 'bought' });
          else dropRun(run.ruleId, run.slot);
          continue;
        } catch (e) {
          if (!(e instanceof TransactionReceiptNotFoundError)) continue; // an RPC error proves nothing
        }
        let seen = run.from && run.nonce != null ? { from: run.from, nonce: run.nonce } : null;
        try {
          const tx = await publicClient.getTransaction({ hash });
          seen = { from: tx.from, nonce: tx.nonce };
          if (alive && (run.from !== tx.from || run.nonce !== tx.nonce) && stillPending(run)) addRun({ ...run, from: tx.from, nonce: tx.nonce });
        } catch (e) {
          if (!(e instanceof TransactionNotFoundError)) continue;
          if (!seen) unknown.add(hash);
        }
        if (!seen) continue;
        try {
          const used = await publicClient.getTransactionCount({ address: seen.from as Hex, blockTag: 'latest' });
          // The nonce is used and this hash has no receipt: it was replaced. A wallet's "Speed up" mines the
          // same buy under another hash, so this is never dropped automatically; the person checks their
          // wallet and can then mark it by hand.
          if (used > seen.nonce) unknown.add(hash);
        } catch {
          // stays pending
        }
      }
      if (alive) setUnknownToNode(unknown);
    })();
    return () => {
      alive = false;
    };
    // re-read every 30 s while something is pending (`now` ticks)
  }, [publicClient, pendingKey, addRun, dropRun, now]);

  const setPaused = (id: string, paused: boolean) => {
    const s = readStore();
    save(s.rules.map((r) => (r.id === id ? { ...r, paused } : r)), s.runs);
  };

  const remove = (id: string) => {
    const s = readStore();
    save(s.rules.filter((r) => r.id !== id), s.runs);
    setConfirmDelete(null);
    if (check?.ruleId === id) setCheck(null);
  };

  const doExport = () => {
    const s = readStore();
    const blob = new Blob([JSON.stringify(exportFile(s.rules, s.runs, Date.now()), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `afterbook-rules-${localDayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setBackupNote(`Saved ${s.rules.length} ${s.rules.length === 1 ? 'rule' : 'rules'} and ${s.runs.length} past ${s.runs.length === 1 ? 'run' : 'runs'} to a file.`);
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 512_000) return setBackupNote('That file is too big to be a rules export.');
    const result = importFile(await file.text(), readStore(), known);
    if (fileRef.current) fileRef.current.value = '';
    if (typeof result === 'string') return setBackupNote(result);
    save(result.rules, result.runs);
    setBackupNote(
      `Imported ${result.added} ${result.added === 1 ? 'rule' : 'rules'}` +
        (result.skipped ? `; ${result.skipped} couldn’t be read (an unknown stock or a bad value) and were left out.` : '.'),
    );
  };

  const checkedRule = check ? rules.find((r) => r.id === check.ruleId) : undefined;
  const checkedStock = check ? getStock(check.leg.symbol) : undefined;
  const checkPending = !!check && runs.some((r) => r.ruleId === check.ruleId && r.slot === check.slot && r.outcome === 'pending');
  const checkedState = check ? states.get(check.ruleId) : null;
  // The swap is shown only while the checked run is still due: once it is pending or bought (by this tab,
  // another tab, or the chain check), a second buy for it is impossible.
  const checkDue = !!check && checkedState?.kind === 'due' && checkedState.slot === check.slot;
  // A swap already sent from this check stays on screen until it is mined, however old the check is.
  const checkStale =
    !!check && !checkPending && (!checkedRule || checkedRule.paused || now - check.checkedAt > CHECK_FRESH_MS || (today !== '' && localDayKey(new Date(check.checkedAt)) !== today));

  return (
    <main className="plan-page">
      <header className="top">
        <h1>Stock rules</h1>
      </header>
      <p className="plan-intro">
        Set a rule once, for example $50 of NVDA every Monday, at most 0.5% over the real stock. When a run is due, Afterbook checks it with the trade plan’s
        checks (gap, earnings, pool depth and cost). A run that passes opens the normal swap for you to review and sign. Nothing buys on its own.
        This is a tool for your own decisions, not financial advice.
      </p>
      <p className="geo-note">
        Your rules are kept in this browser only, never on our server. Clearing site data deletes them, and they don’t sync to your other devices. Use
        Export below to keep a copy. A run waits for you to open this page; it isn’t bought while you’re away.
      </p>
      {saveFailed && <p className="geo-note geo-note-blocked">This browser didn’t let the page save (a private window or blocked storage). Your rules will be lost when you close it.</p>}

      {loaded && (due.length > 0 || (check && checkedRule) || justBought) && (
        <section className="panel rules-due" aria-live="polite">
          <h2>Due now</h2>
          {justBought && (
            <p className="geo-note">
              Bought {usd(justBought.usd, 2)} of {justBought.symbol} for this run ·{' '}
              <a href={`https://basescan.org/tx/${justBought.hash}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                transaction&nbsp;<span className="ext-arrow">↗</span>
              </a>
            </p>
          )}
          {revertNote && <p className="geo-note geo-note-blocked">{revertNote}</p>}
          {due.length === 0 && <p className="plan-hint">Nothing else is due today.</p>}
          <ul className="plan-legs">
            {due.map((rule) => {
              const st = states.get(rule.id);
              if (st?.kind !== 'due') return null;
              const stock = getStock(rule.symbol);
              return (
                <li key={rule.id} className="plan-leg">
                  <div className="plan-leg-head">
                    <SymbolTile cashTicker={stock?.cashTicker ?? rule.symbol} />
                    <div className="plan-leg-name">
                      <strong>
                        {usd(st.usd, 0)} of {rule.symbol}
                      </strong>
                      <span>
                        {cadenceText(rule.cadence)} · run for {dayText(st.slot)}
                      </span>
                    </div>
                  </div>
                  <div className="basket-row">
                    <button type="button" className="btn" disabled={checking !== null} onClick={() => runCheck(rule)}>
                      {checking === rule.id ? 'Checking…' : check?.ruleId === rule.id ? 'Check again' : 'Check this run'}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => skip(rule, st.slot)}>
                      Skip this run
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {checkError && <p className="geo-note geo-note-blocked">{checkError}</p>}

          {check && checkedRule && (
            <div className="plan-swap" ref={checkRef}>
              <div className={`plan-leg plan-leg-${check.leg.verdict}`}>
                <div className="plan-leg-head">
                  <SymbolTile cashTicker={checkedStock?.cashTicker ?? check.leg.symbol} />
                  <div className="plan-leg-name">
                    <strong>{check.leg.symbol}</strong>
                    <span>{check.leg.name}</span>
                  </div>
                  <span className="plan-verdict">{VERDICT_LABEL[check.leg.verdict]}</span>
                </div>
                <dl className="plan-figures">
                  <div>
                    <dt>Gap vs cash {check.leg.gapAgainst}</dt>
                    <dd>{bpPct(check.leg.gapBp)}</dd>
                  </div>
                  <div>
                    <dt>Onchain price</dt>
                    <dd>{usd(check.leg.priceUsd)}</dd>
                  </div>
                  {check.leg.verdict === 'buy' && (
                    <>
                      <div>
                        <dt>Buy</dt>
                        <dd>{usd(check.leg.usd ?? 0, 0)}</dd>
                      </div>
                      <div>
                        <dt>Cost to trade</dt>
                        <dd>{(check.leg.costBp ?? 0).toFixed(1)} bp</dd>
                      </div>
                    </>
                  )}
                </dl>
                <ul className="plan-reasons">
                  {check.leg.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p className="plan-hint">
                  {check.session.label}
                  {check.session.state.startsWith('closed') && ` · cash reopens ${formatNextOpen(check.session.nextOpenIso)}`}
                </p>
              </div>

              {checkPending || !checkDue ? (
                <p className="geo-note">
                  {checkPending ? 'Your wallet sent this run’s buy; it’s waiting to confirm and counts toward the rule’s cap.' : 'This run is no longer due (bought, skipped or paused).'}{' '}
                  {(() => {
                    const h = runs.find((r) => r.ruleId === check.ruleId && r.slot === check.slot)?.hash;
                    return h ? (
                      <a href={`https://basescan.org/tx/${h}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                        Transaction&nbsp;<span className="ext-arrow">↗</span>
                      </a>
                    ) : null;
                  })()}
                </p>
              ) : checkStale ? (
                <p className="geo-note">
                  This check is from {new Date(check.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                  {checkedRule?.paused ? ' and the rule is paused' : ''}. Prices move, so check the run again before buying.
                </p>
              ) : check.leg.verdict === 'buy' && checkedStock ? (
                <>
                  <h3>
                    {check.leg.symbol} · this run: {usd(check.leg.usd ?? 0, 0)}
                  </h3>
                  <p className="geo-note">
                    The swap below gets a fresh quote and runs the usual checks. It starts at this run’s amount and takes at most {usd(check.budgetUsd, 2)};
                    one buy per run, counted toward the rule’s cap. If needed, your wallet asks you to approve exactly the amount you review, then the swap.
                  </p>
                  {geo.nonUs === true ? (
                    <>
                      <label className="eligibility">
                        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
                        I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
                      </label>
                      {eligible ? (
                        <SwapPanel
                          key={`${check.ruleId}-${check.slot}`}
                          stock={checkedStock}
                          defaultUsd={check.leg.usd}
                          source="rule"
                          buyOnly
                          maxUsd={check.budgetUsd}
                          onBuySent={sent(checkedRule, check.slot)}
                          onBought={bought(checkedRule, check.slot)}
                          onBuyReverted={reverted(checkedRule, check.slot)}
                        />
                      ) : (
                        <p className="geo-note">Tick the box above to review the buy.</p>
                      )}
                    </>
                  ) : (
                    <p className="geo-note geo-note-blocked">
                      {geo.country === 'US'
                        ? "Trading is off in the United States: Coinbase's stock tokens aren't offered there. The rules and checks still work."
                        : "Trading is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). The rules and checks still work."}
                    </p>
                  )}
                </>
              ) : (
                <p className="geo-note">
                  This run doesn’t pass your limits right now. Check again later today, or skip it; the next run is still on schedule.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {loaded && rules.length > 0 && (
        <section className="panel">
          <h2>Your rules</h2>
          <ul className="rules-list">
            {rules.map((rule) => {
              const st = states.get(rule.id);
              const stock = getStock(rule.symbol);
              const spent = spentUsd(rule.id, runs);
              const pendingRun = runs.find((r) => r.ruleId === rule.id && r.outcome === 'pending');
              const status =
                !st ? '' :
                st.kind === 'due' ? `Due now (${dayText(st.slot)})` :
                st.kind === 'done-today' && st.outcome === 'pending' ? `Sent for ${dayText(st.slot)}, waiting for it to confirm` :
                st.kind === 'done-today' ? `${st.outcome === 'bought' ? 'Bought' : 'Skipped'} for ${dayText(st.slot)} · next ${dayText(st.next)}` :
                st.kind === 'waiting' ? `Next run ${dayText(st.next)}` :
                st.kind === 'paused' ? 'Paused' :
                'Finished: the total cap is reached';
              return (
                <li key={rule.id} className="rules-item">
                  <div className="plan-leg-head">
                    <SymbolTile cashTicker={stock?.cashTicker ?? rule.symbol} />
                    <div className="plan-leg-name">
                      <strong>
                        {usd(rule.usd, 0)} of {rule.symbol} · {cadenceText(rule.cadence)}
                      </strong>
                      <span>
                        At most {(rule.maxPremiumBp / 100).toFixed(2)}% over the real stock and {(rule.maxCostBp / 100).toFixed(2)}% to trade
                        {rule.earningsDays > 0 ? ` · pause within ${rule.earningsDays} days of earnings` : ''}
                      </span>
                    </div>
                    <span className={st?.kind === 'due' ? 'plan-verdict rules-due-pill' : 'plan-verdict'}>{status}</span>
                  </div>
                  <p className="plan-hint">
                    Spent so far: {usd(spent, 2)}
                    {rule.capUsd != null && ` of a ${usd(rule.capUsd, 0)} cap`}
                    {rule.capUsd != null && runBudget(rule, runs) > 0 && runBudget(rule, runs) < rule.usd && ` · the last run is ${usd(runBudget(rule, runs), 2)}`}
                  </p>
                  {pendingRun && (
                    <p className="plan-hint">
                      Your wallet sent this run’s buy; it counts toward the cap until it confirms.
                      {unknownToNode.has(pendingRun.hash ?? '') && now - pendingRun.at > PENDING_GIVE_UP_MS
                        ? ' This transaction hasn’t been found. If you sped it up or cancelled it in your wallet, it may have gone through under another hash: check your wallet’s activity before marking it.'
                        : ''}{' '}
                      <a href={`https://basescan.org/tx/${pendingRun.hash}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                        Transaction&nbsp;<span className="ext-arrow">↗</span>
                      </a>
                    </p>
                  )}
                  <div className="basket-row">
                    {pendingRun && unknownToNode.has(pendingRun.hash ?? '') && now - pendingRun.at > PENDING_GIVE_UP_MS && (
                      <button type="button" className="btn btn-secondary" onClick={() => dropRun(pendingRun.ruleId, pendingRun.slot)}>
                        It didn’t go through
                      </button>
                    )}
                    {st?.kind !== 'finished' && (
                      <button type="button" className="btn btn-secondary" onClick={() => setPaused(rule.id, !rule.paused)}>
                        {rule.paused ? 'Resume' : 'Pause'}
                      </button>
                    )}
                    {confirmDelete === rule.id ? (
                      <>
                        <button type="button" className="btn" onClick={() => remove(rule.id)}>
                          Delete the rule
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>
                          Keep it
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(rule.id)}>
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <form className="panel plan-form" onSubmit={submit}>
        <h2>{rules.length ? 'Add a rule' : 'Your first rule'}</h2>
        <div className="plan-grid">
          <label className="plan-field">
            <span>Stock</span>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {rows.map((r) => (
                <option key={r.symbol} value={r.symbol}>
                  {r.cashTicker} · {r.name}
                </option>
              ))}
            </select>
            <small>Pools of at least {usd(TAPE_MAIN_DEPTH_USD, 0)}.</small>
          </label>
          <label className="plan-field">
            <span>Each run (USDC)</span>
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>
              {usd(RULE_LIMITS.minRunUsd, 0)} to {usd(RULE_LIMITS.maxRunUsd, 0)}; also at most 10% of the pool.
            </small>
          </label>
          <label className="plan-field">
            <span>How often</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Cadence['kind'])}>
              <option value="weekly">Every week</option>
              <option value="biweekly">Every other week</option>
              <option value="monthly">Every month</option>
            </select>
            <small>A missed run waits until the next one; runs never pile up.</small>
          </label>
          {kind === 'monthly' ? (
            <label className="plan-field">
              <span>Day of the month</span>
              <select value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))}>
                {Array.from({ length: RULE_LIMITS.maxMonthDay }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <small>Up to the 28th, so every month has it.</small>
            </label>
          ) : (
            <label className="plan-field">
              <span>On</span>
              <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
              <small>Tokens trade on weekends too.</small>
            </label>
          )}
        </div>
        <div className="plan-grid">
          <label className="plan-field">
            <span>Total cap (USDC, optional)</span>
            <input inputMode="decimal" value={cap} placeholder="No cap" onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>The rule stops once it has bought this much.</small>
          </label>
          <label className="plan-field">
            <span>Most I’ll pay over the real stock (%)</span>
            <input inputMode="decimal" value={premiumPct} onChange={(e) => setPremiumPct(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>Above this, the run waits.</small>
          </label>
          <label className="plan-field">
            <span>Most I’ll pay to trade (%)</span>
            <input inputMode="decimal" value={costPct} onChange={(e) => setCostPct(e.target.value.replace(/[^0-9.]/g, ''))} />
            <small>Price impact plus the pool fee; a run is sized down to fit.</small>
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
        <div className="basket-row">
          <button type="submit" className="btn" disabled={!loaded}>
            Save the rule
          </button>
        </div>
        {formError && <p className="geo-note geo-note-blocked">{formError}</p>}
      </form>

      {loaded && runs.length > 0 && (
        <section className="panel plan-log">
          <h2>Past runs</h2>
          <ul className="plan-log-list">
            {runs.map((r) => (
              <li key={`${r.ruleId}-${r.slot}`}>
                <span className="plan-log-date">{dayText(r.slot)}</span>
                <span className="plan-log-leg">
                  {r.outcome !== 'skipped' ? (
                    <>
                      {r.outcome === 'bought' ? 'Bought' : 'Sent (not confirmed yet):'} {usd(r.usd ?? 0, 2)} of {r.symbol}
                      {r.hash && (
                        <>
                          {' · '}
                          <a href={`https://basescan.org/tx/${r.hash}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                            transaction&nbsp;<span className="ext-arrow">↗</span>
                          </a>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {r.symbol}: {r.reason ?? 'Skipped.'}
                    </>
                  )}
                  {!rules.some((x) => x.id === r.ruleId) && <span className="plan-hint"> (rule deleted)</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Back up or move your rules</h2>
        <p className="plan-hint">
          Export saves your rules and past runs to a file. Import it in another browser, or here after clearing site data. Importing adds to what’s here; a
          rule with the same id is replaced.
        </p>
        <div className="basket-row">
          <button type="button" className="btn btn-secondary" disabled={!loaded} onClick={doExport}>
            Export
          </button>
          <button type="button" className="btn btn-secondary" disabled={!loaded} onClick={() => fileRef.current?.click()}>
            Import
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => void doImport(e.target.files?.[0])} />
        </div>
        {backupNote && <p className="geo-note">{backupNote}</p>}
      </section>

      <p className="geo-note">
        <Link href="/plan" className="page-link">
          Make a one-off trade plan<span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
