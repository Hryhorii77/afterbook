'use client';

// One due run of a rebalance rule on /rules (lib/agent/rebalance.ts, owner 2026-11-14): where the wallet's
// basket stands against its targets (read onchain when the run was checked), what this run would buy (the
// stocks below target, in proportion to how far below), and the normal basket buy to review and sign it,
// behind the same region and eligibility checks. Buy-only: nothing is sold. The drift view also links to
// /build for anyone who wants to rebalance by hand.
import Link from 'next/link';
import type { Hex } from 'viem';
import type { GeoInfo } from '@/lib/server/geo';
import type { Rule } from '@/lib/agent/rules';
import type { RebalancePlan } from '@/lib/agent/rebalancePlan';
import { formatSpec } from '@/lib/build/customBasket';
import { getStock } from '@/lib/stocks/tokens';
import { formatNextOpen, usd } from '@/lib/format';
import { BasketBuyPanel } from '../baskets/BasketBuyPanel';

export interface RebalanceCheck {
  ruleId: string;
  slot: string;
  plan: RebalancePlan;
  session: { state: string; label: string; nextOpenIso: string };
  checkedAt: number;
  /** When the holdings were read, at which Base block, and for which wallet. */
  readAtMs: number;
  blockNumber: string;
  address: string;
  /** What the run may spend (the rule's amount, cut to what's left of its cap). */
  budgetUsd: number;
}

const ticker = (s: string) => s.replace(/c$/, '');
const pct = (v: number) => `${v.toFixed(1)}%`;
const pts = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} pts`;

export function RebalanceRun({
  check,
  rule,
  geo,
  eligible,
  setEligible,
  mode,
  onRunSent,
  onRunDone,
  onRunNothing,
  onBusy,
  locked,
}: {
  check: RebalanceCheck;
  rule: Rule;
  geo: GeoInfo;
  eligible: boolean;
  setEligible: (v: boolean) => void;
  /** 'buy': due and fresh; 'pending': its buy was sent; 'gone': no longer due; 'stale': check again. */
  mode: 'buy' | 'pending' | 'gone' | 'stale';
  onRunSent: (totalUsd: number, hash: Hex) => void;
  onRunDone: (r: { paidUsd: number; hashes: Hex[]; notBought: string[] }) => void;
  onRunNothing: () => void;
  /** The basket buy is preparing, asking the wallet or sending: the page locks everything that could unmount it. */
  onBusy: (busy: boolean) => void;
  /** A run is in progress: the eligibility box can't be unticked (that would unmount the buy mid-run). */
  locked: boolean;
}) {
  const { plan } = check;
  const held = plan.drift.reduce((s, d) => s + d.valueUsd, 0);
  const targets = rule.targets ?? [];
  const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="plan-swap rebalance-run">
      <h3>Where your basket stands</h3>
      <ul className="plan-reasons rebalance-drift">
        {plan.drift.map((d) => (
          <li key={d.symbol}>
            <strong>{ticker(d.symbol)}</strong> {usd(d.valueUsd, 2)}
            {d.currentPct != null ? ` · ${pct(d.currentPct)} now vs ${d.targetPct}% target (${pts(d.driftPts!)})` : ` · ${d.targetPct}% target`}
          </li>
        ))}
      </ul>
      <p className="plan-hint">
        Holdings read onchain at {time(check.readAtMs)} (Base block {Number(check.blockNumber).toLocaleString('en-US')}) for {check.address.slice(0, 6)}…{check.address.slice(-4)}, valued at
        the pool prices. {held > 0 ? '' : 'You hold none of these yet, so this run buys at the target weights. '}
        {check.session.label}
        {check.session.state.startsWith('closed') && ` · cash reopens ${formatNextOpen(check.session.nextOpenIso)}`}
      </p>
      <p className="plan-hint">
        A rule run only buys. To sell what is over target, rebalance by hand on{' '}
        <Link href={`/build/${formatSpec(targets)}`} className="emph-link">
          this basket’s page
        </Link>
        .
      </p>

      {plan.picks ? (
        <>
          <h3>This run: {usd(plan.investedUsd, 2)}</h3>
          <ul className="plan-reasons">
            {plan.picks.map((p) => (
              <li key={p.symbol}>
                {ticker(p.symbol)} {usd(p.usd, 2)} ({p.weightPct}% of this run), cost to trade about {(p.costBp / 100).toFixed(2)}%
                {p.sizedDownBy ? `, cut by ${p.sizedDownBy === 'cost limit' ? 'your cost limit' : 'the swap caps'}` : ''}
              </li>
            ))}
          </ul>
          {plan.cashUsd >= 0.01 && (
            <p className="plan-hint">
              {usd(plan.cashUsd, 2)} of this run’s {usd(check.budgetUsd, 2)} stays in your wallet: weights are whole percents
              {plan.picks.some((p) => p.sizedDownBy) ? ', and a stock was cut to fit your limits' : ''}.
            </p>
          )}
        </>
      ) : (
        <p className="geo-note">{plan.shortfall}</p>
      )}
      {plan.picks && plan.notBought.length > 0 && (
        <ul className="plan-reasons">
          {plan.notBought.map((n) => (
            <li key={n.symbol}>
              {ticker(n.symbol)} isn’t bought this run: {n.why}
            </li>
          ))}
        </ul>
      )}

      {mode === 'pending' ? (
        <p className="geo-note">Your wallet sent this run’s first swap; the run counts toward the rule’s cap and waits for it to confirm.</p>
      ) : mode === 'gone' ? (
        <p className="geo-note">This run is no longer due (bought, skipped or paused).</p>
      ) : mode === 'stale' ? (
        <p className="geo-note">
          This check is from {new Date(check.checkedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
          {rule.paused ? ' and the rule is paused' : ''}. Prices and holdings move, so check the run again before buying.
        </p>
      ) : plan.picks && plan.basket ? (
        geo.nonUs === true ? (
          <>
            <p className="geo-note">
              The basket buy below asks your wallet to approve exactly the total you review for KyberSwap’s router, then one swap per stock, each rebuilt and
              checked before you sign. It takes at most {usd(check.budgetUsd, 2)}; one buy per run, counted toward the rule’s cap.
            </p>
            <label className="eligibility">
              <input type="checkbox" checked={eligible} disabled={locked} onChange={(e) => setEligible(e.target.checked)} />
              I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
            </label>
            {eligible ? (
              <BasketBuyPanel
                key={`${check.ruleId}-${check.slot}-${check.checkedAt}`}
                legs={plan.basket}
                stocks={plan.basket.map((b) => ({ symbol: b.symbol, decimals: getStock(b.symbol)?.decimals ?? 8 }))}
                defaultUsd={plan.investedUsd}
                maxUsd={check.budgetUsd}
                onRunSent={onRunSent}
                onRunDone={onRunDone}
                onRunNothing={onRunNothing}
                onBusy={onBusy}
                noRest
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
        )
      ) : (
        <p className="geo-note">Nothing passes your limits for this run right now. Check again later today, or skip it; the next run is still on schedule.</p>
      )}
    </div>
  );
}
