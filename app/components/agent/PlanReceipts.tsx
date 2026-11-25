'use client';

// Plan receipts (2026-11-25): each buy signed from this link and verified onchain, next to what the plan said.
// Numbers only: no transaction hash or wallet, since a plan link can be shared (lib/agent/planReceipt.ts). The amounts
// shown are rounded (whole dollars, tokens to 3 significant figures): exact figures could be searched in the router's
// events to find the transaction and the buyer. The comparisons are worked out from the exact numbers.
import type { PlanReceipt } from '@/lib/agent/planReceipt';
import { usd } from '@/lib/format';

const roughUsd = (n: number) => (n >= 1 ? `about $${Math.round(n).toLocaleString('en-US')}` : 'under $1');
const roughTokens = (n: number) => Number(n.toPrecision(3)).toLocaleString('en-US', { maximumFractionDigits: 8 });
const pct = (bp: number) => `${(Math.abs(bp) / 100).toFixed(2)}%`;
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

export function PlanReceipts({ receipts, byBot }: { receipts: PlanReceipt[]; byBot: boolean }) {
  return (
    <section className="panel plan-receipts">
      <h2>Receipts</h2>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Buys signed from this link, each verified onchain: what the {byBot ? 'bot' : 'plan'} said next to what filled. The stock received is the
        chain&apos;s own figure, not a quote.
      </p>
      <ul className="plan-receipt-list">
        {receipts.map((r, i) => (
          <li key={`${r.symbol}-${r.at}-${i}`} className="plan-receipt">
            <div className="plan-receipt-head">
              <strong>{r.symbol}</strong>
              <span className="plan-receipt-when" suppressHydrationWarning>
                filled {ago(r.afterPlanMs)} after the plan
              </span>
            </div>
            <dl>
              <dt>Plan said</dt>
              <dd>
                {r.plannedUsd != null ? `buy up to ${usd(r.plannedUsd, 2)}` : 'buy'}
                {r.plannedPriceUsd != null && ` at about ${usd(r.plannedPriceUsd, 2)} a share`}
                {r.plannedCostBp != null && `, cost about ${pct(r.plannedCostBp)}`} (limit {pct(r.costLimitBp)})
              </dd>
              <dt>Filled</dt>
              <dd>
                {roughUsd(r.paidUsd)} for about {roughTokens(r.tokens)} {r.symbol}, {usd(r.fillPriceUsd, 2)} a share
                {r.vsPlanPriceBp != null && (
                  <>
                    {' '}
                    ({r.vsPlanPriceBp === 0 ? 'the plan’s price' : `${pct(r.vsPlanPriceBp)} ${r.vsPlanPriceBp > 0 ? 'above' : 'below'} the plan’s price`})
                  </>
                )}
              </dd>
              <dt>Checks</dt>
              <dd>
                {[
                  r.vsQuoteBp != null ? (r.vsQuoteBp >= 0 ? `${pct(r.vsQuoteBp)} more than quoted at signing` : `${pct(r.vsQuoteBp)} less than quoted at signing`) : null,
                  r.metMinimum === true ? 'at least the signed minimum' : r.metMinimum === false ? 'below the signed minimum' : null,
                  r.withinPlan === true ? 'within the plan’s amount' : r.withinPlan === false ? 'over the plan’s amount' : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
