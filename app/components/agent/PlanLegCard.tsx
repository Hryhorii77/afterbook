// One stock of a trade plan: its verdict, figures and reasons, as the code wrote them. Shared by /plan and
// an agent's saved plan (/plan/<id>); the action under it (a "Review" button) is the page's own.
import type { ReactNode } from 'react';
import type { PlanLeg } from '@/lib/agent/plan';
import { getStock } from '@/lib/stocks/tokens';
import { bpPct, usd } from '@/lib/format';
import { SymbolTile } from '../ui/SymbolTile';

export const VERDICT_LABEL: Record<PlanLeg['verdict'], string> = { buy: 'Passes your limits', wait: 'Wait', skip: 'Skip' };

export function PlanLegCard({ leg, children }: { leg: PlanLeg; children?: ReactNode }) {
  const stock = getStock(leg.symbol);
  return (
    <li className={`plan-leg plan-leg-${leg.verdict}`}>
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
      {children}
    </li>
  );
}
