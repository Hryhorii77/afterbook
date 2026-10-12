'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatSpec, normalizeLegs, MAX_LEGS, MIN_LEGS, type BasketLeg } from '@/lib/customBasket';

interface Props {
  /** Every tracked symbol, liquid ones first. */
  symbols: { symbol: string; thin: boolean }[];
  initial: BasketLeg[];
}

// Choose 2–4 stocks and their weights, then load that basket's own URL —
// the page itself is server-rendered from the URL, so a basket is always a
// link someone can share, and nothing is kept in the browser.
export function BasketPicker({ symbols, initial }: Props) {
  const router = useRouter();
  const [legs, setLegs] = useState(() => initial.map((l) => ({ symbol: l.symbol, weight: String(l.weightPct) })));
  const picked = new Set(legs.map((l) => l.symbol));

  const toggle = (symbol: string) => {
    if (picked.has(symbol)) {
      setLegs(legs.filter((l) => l.symbol !== symbol));
    } else if (legs.length < MAX_LEGS) {
      // A new leg starts at an equal share of what is already there.
      setLegs([...legs, { symbol, weight: String(Math.round(100 / (legs.length + 1))) }]);
    }
  };
  const equalize = () => setLegs(legs.map((l) => ({ ...l, weight: String(Math.round(100 / legs.length)) })));

  const total = legs.reduce((s, l) => s + (Number(l.weight) || 0), 0);
  const canShow = legs.length >= MIN_LEGS && legs.length <= MAX_LEGS;

  const show = () => {
    const spec = formatSpec(normalizeLegs(legs.map((l) => ({ symbol: l.symbol, weight: Number(l.weight) }))));
    router.push(`/build/${spec}`);
  };

  return (
    <>
      <div className="size-presets" role="group" aria-label="Stocks in the basket">
        {symbols.map(({ symbol, thin }) => (
          <button
            key={symbol}
            type="button"
            className={picked.has(symbol) ? 'preset-btn preset-btn-active' : 'preset-btn'}
            aria-pressed={picked.has(symbol)}
            disabled={!picked.has(symbol) && legs.length >= MAX_LEGS}
            onClick={() => toggle(symbol)}
            title={thin ? 'Thin pool: small trades move its price a lot' : undefined}
          >
            {symbol}
            {thin ? ' · thin' : ''}
          </button>
        ))}
      </div>

      {legs.length > 0 && (
        <div className="lot-lab-form" style={{ marginTop: 16 }}>
          {legs.map((l, i) => (
            <div className="field" key={l.symbol}>
              <label htmlFor={`w-${l.symbol}`}>{l.symbol} weight (%)</label>
              <input
                id={`w-${l.symbol}`}
                type="number"
                min={1}
                max={100}
                step={1}
                value={l.weight}
                onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))}
              />
            </div>
          ))}
        </div>
      )}

      <p className="geo-note">
        {legs.length < MIN_LEGS
          ? `Pick ${MIN_LEGS} to ${MAX_LEGS} stocks.`
          : total === 100
            ? `${legs.length} stocks, weights add up to 100%.`
            : `Weights add up to ${total}%; they will be scaled to 100%.`}
      </p>

      <div className="basket-row">
        <button type="button" className="btn" disabled={!canShow} onClick={show}>
          Show this basket
        </button>
        <button type="button" className="btn btn-secondary" disabled={legs.length < MIN_LEGS} onClick={equalize}>
          Equal weights
        </button>
      </div>
    </>
  );
}
