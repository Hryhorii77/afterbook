'use client';

// Plan receipts (2026-11-25): each buy signed from this link and verified onchain, next to what the plan said.
// The page gets display text and pass/fail checks only (receiptView in lib/agent/planReceipt.ts, on the server):
// no transaction hash, wallet, exact amount or time, since a plan link can be shared and exact figures could be
// searched in the router's events to find the buyer.
import type { ReceiptView } from '@/lib/agent/planReceipt';

export function PlanReceipts({ receipts, byBot }: { receipts: ReceiptView[]; byBot: boolean }) {
  return (
    <section className="panel plan-receipts">
      <h2>Receipts</h2>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Buys signed from this link, each verified onchain: what the {byBot ? 'bot' : 'plan'} said next to what filled, rounded. The stock received
        is the chain&apos;s own figure, not a quote.
      </p>
      <ul className="plan-receipt-list">
        {receipts.map((r, i) => (
          <li key={`${r.symbol}-${i}`} className="plan-receipt">
            <div className="plan-receipt-head">
              <strong>{r.symbol}</strong>
              <span className="plan-receipt-when">filled {r.when}</span>
            </div>
            <dl>
              <dt>Plan said</dt>
              <dd>{r.planSaid}</dd>
              <dt>Filled</dt>
              <dd>{r.filled}</dd>
              <dt>Checks</dt>
              <dd>
                {r.checks.map((c, j) => (
                  <span key={j} className={c.ok ? 'plan-receipt-check' : 'plan-receipt-check plan-receipt-check-bad'}>
                    {j > 0 && ' · '}
                    {c.label}
                  </span>
                ))}
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
