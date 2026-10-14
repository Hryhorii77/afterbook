'use client';

import { useState } from 'react';
import type { GeoInfo } from '@/lib/geo';
import type { BasketLeg } from '@/lib/customBasket';
import { BasketBuyPanel } from './BasketBuyPanel';
import { BasketSellPanel, type SellStock } from './BasketSellPanel';

// The /build page's Buy / Sell panel behind the same two gates as a stock's Execute panel: the
// fail-closed non-US region check (the swap routes refuse anyone else anyway) and the eligibility box.
export function BasketBuySection({ legs, stocks, geo }: { legs: BasketLeg[]; stocks: SellStock[]; geo: GeoInfo }) {
  const [eligible, setEligible] = useState(false);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  // While either panel is asking the wallet, the switch and the box are locked: a run must stay on
  // screen until it ends, so what it signs and any stop are always visible.
  const [busy, setBusy] = useState(false);
  const unlocked = geo.nonUs === true && eligible;
  return (
    <>
      <label className="eligibility">
        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} disabled={busy} />
        I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
      </label>
      <div className="carry-direction-toggle swap-side-toggle" role="tablist" aria-label="Buy or sell the basket">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={side === s}
            className={side === s && unlocked ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
            onClick={() => setSide(s)}
            disabled={!unlocked || busy}
          >
            {s === 'buy' ? 'Buy basket' : 'Sell basket'}
          </button>
        ))}
      </div>
      {/* Both stay mounted once unlocked (hidden, not removed), so a run's progress is never lost. */}
      {geo.nonUs === true && (
        <>
          <div hidden={!unlocked || side !== 'buy'}>
            <BasketBuyPanel legs={legs} stocks={stocks} onBusy={setBusy} />
          </div>
          <div hidden={!unlocked || side !== 'sell'}>
            <BasketSellPanel stocks={stocks} onBusy={setBusy} />
          </div>
        </>
      )}
      {unlocked ? null : (
        <p className="geo-note">{geo.nonUs === true ? 'Confirm eligibility to trade.' : geo.country === 'US' ? 'Not available in the US.' : 'Region could not be detected, so trading is off.'}</p>
      )}
      <p className="geo-note">
        {geo.country ? `Detected region: ${geo.country}. ` : ''}Trades are signed in your own wallet; Afterbook never holds your funds. Each stock is a separate
        KyberSwap swap, checked by the server field by field like a single trade.
      </p>
    </>
  );
}
