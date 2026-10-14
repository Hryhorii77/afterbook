'use client';

import { useState } from 'react';
import type { GeoInfo } from '@/lib/geo';
import type { BasketLeg } from '@/lib/customBasket';
import { BasketBuyPanel } from './BasketBuyPanel';

// The /build page's "Buy it" panel behind the same two gates as a stock's Execute panel: the
// fail-closed non-US region check (the swap routes refuse anyone else anyway) and the eligibility box.
export function BasketBuySection({ legs, stocks, geo }: { legs: BasketLeg[]; stocks: { symbol: string; decimals: number }[]; geo: GeoInfo }) {
  const [eligible, setEligible] = useState(false);
  const unlocked = geo.nonUs === true && eligible;
  return (
    <>
      <label className="eligibility">
        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
        I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
      </label>
      {unlocked ? (
        <BasketBuyPanel legs={legs} stocks={stocks} />
      ) : (
        <p className="geo-note">{geo.nonUs === true ? 'Confirm eligibility to buy.' : geo.country === 'US' ? 'Not available in the US.' : 'Region could not be detected, so buying is off.'}</p>
      )}
      <p className="geo-note">
        {geo.country ? `Detected region: ${geo.country}. ` : ''}Trades are signed in your own wallet; Afterbook never holds your funds. Each stock is a separate
        KyberSwap swap, checked by the server field by field like a single buy.
      </p>
    </>
  );
}
