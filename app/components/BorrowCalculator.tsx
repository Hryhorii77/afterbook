'use client';

import { useMemo, useState } from 'react';
import { positionRisk, type SellCurvePoint } from '@/lib/liquidationMath';
import { usd } from '@/lib/format';

export interface CalculatorMarket {
  marketId: string;
  symbol: string;
  venue: string;
  lltv: number;
  /** The market's liquidation incentive (Morpho and Aave work it out differently). */
  lif: number;
  oraclePriceUsd: number;
  aeroVsOracleBp: number;
}

interface Props {
  markets: CalculatorMarket[];
  curves: Record<string, SellCurvePoint[]>;
}

const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

export function BorrowCalculator({ markets, curves }: Props) {
  const [marketId, setMarketId] = useState(markets[0]?.marketId ?? '');
  const market = markets.find((m) => m.marketId === marketId) ?? markets[0];
  const [sharesInput, setSharesInput] = useState('10');
  // Default to borrowing 40% of the collateral value — well inside every
  // listed LLTV, so the first thing a visitor sees is a safe-looking loan.
  const [borrowInput, setBorrowInput] = useState(() => (market ? String(Math.round(10 * market.oraclePriceUsd * 0.4)) : '1000'));

  const risk = useMemo(() => {
    if (!market) return null;
    return positionRisk({
      collateralShares: Number(sharesInput),
      borrowUsd: Number(borrowInput),
      lltv: market.lltv,
      lif: market.lif,
      oraclePriceUsd: market.oraclePriceUsd,
      aeroGap: market.aeroVsOracleBp / 10_000,
      curve: curves[market.symbol] ?? [],
    });
  }, [market, sharesInput, borrowInput, curves]);

  if (!market) return null;
  const collateralUsd = Number(sharesInput) * market.oraclePriceUsd;
  const ltv = collateralUsd > 0 ? Number(borrowInput) / collateralUsd : null;

  return (
    <>
      <div className="lot-lab-form">
        <div className="field">
          <label htmlFor="borrow-market">Market</label>
          <select id="borrow-market" value={market.marketId} onChange={(e) => setMarketId(e.target.value)}>
            {markets.map((m) => (
              <option key={m.marketId} value={m.marketId}>
                {m.symbol} · {m.venue} · max LTV {pct(m.lltv)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="borrow-shares">Collateral (shares)</label>
          <input id="borrow-shares" type="number" min={0} step="any" value={sharesInput} onChange={(e) => setSharesInput(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="borrow-usdc">Borrowed (USDC)</label>
          <input id="borrow-usdc" type="number" min={0} step="any" value={borrowInput} onChange={(e) => setBorrowInput(e.target.value)} />
        </div>
      </div>

      {!risk ? (
        <p className="geo-note">Enter a collateral amount and a loan above zero.</p>
      ) : (
        <>
          <div className="result-grid">
            <div className="result-cell">
              <div className="label">Liquidated if {market.symbol} falls to</div>
              <div className="value">{usd(risk.liquidationPriceUsd)}</div>
            </div>
            <div className="result-cell">
              <div className="label">Room to fall</div>
              <div className={`value ${risk.dropToLiquidation <= 0.1 ? 'basis-neg' : ''}`}>
                {risk.dropToLiquidation <= 0 ? 'None' : pct(risk.dropToLiquidation)}
              </div>
            </div>
            <div className="result-cell">
              <div className="label">Loan to value now</div>
              <div className="value">{ltv == null ? '—' : pct(ltv)}</div>
            </div>
          </div>
          <p className="geo-note">
            {risk.dropToLiquidation <= 0 ? (
              <>This loan is already over the market&apos;s limit and could be liquidated now. </>
            ) : null}
            {risk.dropToLiquidation <= 0 ? 'A' : 'At that price a'} liquidator would take about {usd(risk.seizedUsd, 0)}{' '}
            of your {market.symbol} to clear the loan.{' '}
            {risk.sellDiscountBp == null ? (
              <>That is close to or more than all the USDC the Aerodrome pool holds near the price today, so it may not sell there in one go.</>
            ) : risk.aeroLiquidationProfitable ? (
              <>
                Selling that on Aerodrome would fill about {risk.sellDiscountBp.toFixed(0)} bp below the pool price, which
                still pays the liquidator, so the pool could absorb it today.
              </>
            ) : (
              <>
                Selling that on Aerodrome would fill about {risk.sellDiscountBp.toFixed(0)} bp below the pool price, which
                would not pay a liquidator who has to sell there. The liquidation could come late, and lenders could be
                left short.
              </>
            )}
          </p>
        </>
      )}
    </>
  );
}
