'use client';

import { useState } from 'react';
import type { AavePosition, AaveReserve } from '@/lib/lending/aaveBorrow';
import { planRescue, RESCUE_FALLS, RESCUE_TARGETS } from '@/lib/lending/rescue';
import { formatUnits } from 'viem';
import { usd } from '../swap/swapClient';

// The loan rescue planner (lib/lending/rescue.ts) inside the borrow panel: pick a price fall and a target
// health, see the USDC to repay or the stock to add, and fill the panel's own Repay or Add field with
// it. It never builds or signs anything: the panel's button, approvals and checks do that as usual.

/** The exact amount a button fills, with thousands separators: never rounded, so the sentence and the
 *  filled box always match (from the real-money review). */
const exact = (raw: bigint, decimals: number) => {
  const [int, frac] = formatUnits(raw, decimals).split('.');
  return `${BigInt(int).toLocaleString('en-US')}${frac ? `.${frac}` : ''}`;
};
const hf = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : 'no loan');
const fallLabel = (f: number) => (f === 0 ? 'Prices as they are' : `Every stock falls ${Math.round(f * 100)}%`);

export function LoanRescue({
  position,
  chainHealth,
  balances,
  usdcBalance,
  disabled,
  onRepay,
  onAdd,
}: {
  position: AavePosition;
  chainHealth: number;
  balances: Map<number, bigint>;
  usdcBalance: bigint;
  disabled: boolean;
  onRepay: (raw: bigint, all: boolean) => void;
  onAdd: (reserve: AaveReserve, raw: bigint) => void;
}) {
  const [fall, setFall] = useState<number>(0.2);
  const [target, setTarget] = useState<number>(1.5);
  const plan = planRescue(position, { fall, target, chainHealth, balances, usdcBalance });
  if (plan.kind === 'no-loan') return null;

  return (
    <div className="rescue" id="rescue">
      <h3>Rescue planner</h3>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Test your loan against a fall in Aave&apos;s stock prices and see what keeps it at a health you choose. A test, not a forecast.
      </p>
      <div className="rescue-fields">
        <div className="action-field">
          <label htmlFor="rescue-fall">If</label>
          <select id="rescue-fall" value={fall} onChange={(e) => setFall(Number(e.target.value))} disabled={disabled}>
            {RESCUE_FALLS.map((f) => (
              <option key={f} value={f}>
                {fallLabel(f)}
              </option>
            ))}
          </select>
        </div>
        <div className="action-field">
          <label htmlFor="rescue-target">Keep health at least</label>
          <select id="rescue-target" value={target} onChange={(e) => setTarget(Number(e.target.value))} disabled={disabled}>
            {RESCUE_TARGETS.map((t) => (
              <option key={t} value={t}>
                {t.toFixed(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {plan.kind === 'paused' ? (
        <p className="geo-note geo-note-blocked">
          The planner is off for this loan: {plan.why}, so its amounts could be wrong. Use the Repay or Borrow tab yourself, or Aave&apos;s own app.
        </p>
      ) : plan.safe ? (
        <p className="geo-note">
          Health would be {hf(plan.healthStressed)}, at or above {target.toFixed(1)}. Nothing to do for this case.
        </p>
      ) : (
        <>
          <p className={plan.healthStressed < 1 ? 'geo-note geo-note-blocked' : 'geo-note'}>
            Health would be {hf(plan.healthStressed)}
            {plan.healthStressed < 1 ? ': under 1.00, so part of your collateral could be sold (liquidated).' : ` (liquidation below 1.00).`} To keep it
            at {target.toFixed(1)}{plan.adds.length > 0 ? ', either:' : ':'}
          </p>
          <ul className="rescue-options">
            <li>
              <span>
                Repay {plan.repay.all ? `all you owe, ${exact(plan.repay.raw, 6)} USDC` : `${exact(plan.repay.raw, 6)} USDC`} → health{' '}
                {hf(plan.repay.healthAfter)}
                {plan.repay.partial
                  ? ` · your wallet holds ${exact(plan.repay.partial.raw, 6)} USDC, which gets it to ${hf(plan.repay.partial.healthAfter)}`
                  : usdcBalance === BigInt(0) && ' · your wallet holds no USDC on Base'}
              </span>
              {(plan.repay.partial || usdcBalance > BigInt(0)) && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabled}
                  onClick={() => (plan.repay.partial ? onRepay(plan.repay.partial.raw, false) : onRepay(plan.repay.raw, plan.repay.all))}
                >
                  {plan.repay.partial ? 'Fill what you hold' : 'Fill the repay'}
                </button>
              )}
            </li>
            {plan.adds.map((a) => {
              const c = position.collateral.find((x) => x.reserve.reserveId === a.reserve.reserveId);
              const value = c ? (Number(a.addRaw) / 10 ** a.reserve.decimals) * c.priceUsd : 0;
              return (
                <li key={a.reserve.reserveId}>
                  <span>
                    Add {exact(a.addRaw, a.reserve.decimals)} {a.reserve.symbol} ({usd(value)} now) as collateral → health {hf(a.healthAfter)}
                    {c && c.suppliedRaw > BigInt(0) && !c.enabled && ` · this also turns on the ${exact(c.suppliedRaw, a.reserve.decimals)} ${a.reserve.symbol} you posted but switched off as collateral`}
                    {a.partial && ` · your wallet holds ${exact(a.partial.raw, a.reserve.decimals)}, which gets it to ${hf(a.partial.healthAfter)}`}
                  </span>
                  <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => onAdd(a.reserve, a.partial ? a.partial.raw : a.addRaw)}>
                    {a.partial ? 'Fill what you hold' : 'Fill the add'}
                  </button>
                </li>
              );
            })}
          </ul>
          {plan.adds.length === 0 && <p className="geo-note">Your wallet holds none of the stocks this pool takes as collateral, so repaying is the way here.</p>}
          <p className="geo-note">
            Every stock is assumed to fall by the same share; the debt is in USDC and doesn&apos;t move. Amounts are rounded up with a little
            room for interest. Filling only puts the amount in the form below: your wallet then asks you to approve and sign as usual.
          </p>
        </>
      )}
    </div>
  );
}
