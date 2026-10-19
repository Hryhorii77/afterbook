'use client';

import { useState } from 'react';
import type { GeoInfo } from '@/lib/geo';
import type { CbStock } from '@/lib/tokens';
import { MemeBuyPanel } from './MemeBuyPanel';

// The meme page's Buy panel behind the same gates as a stock's Execute panel: the fail-closed non-US
// region check (the swap routes refuse anyone else anyway) and a box the visitor ticks themselves, here
// also saying they understand the risk. The warning above it on the page cannot be dismissed.
export function MemeBuySection({ meme, stock, geo }: { meme: { address: `0x${string}`; symbol: string; decimals: number }; stock: CbStock; geo: GeoInfo }) {
  const [eligible, setEligible] = useState(false);
  const unlocked = geo.nonUs === true && eligible;
  return (
    <>
      <label className="eligibility">
        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
        I confirm I am not a US person, am eligible under my local law to trade tokenized equities, and understand {meme.symbol} can go to zero.
      </label>
      {geo.nonUs === true && (
        <div hidden={!unlocked}>
          <MemeBuyPanel meme={meme} stock={stock} />
        </div>
      )}
      {unlocked ? null : (
        <p className="geo-note">{geo.nonUs === true ? 'Tick the box to buy.' : geo.country === 'US' ? 'Not available in the US.' : 'Region could not be detected, so buying is off.'}</p>
      )}
      <p className="geo-note">
        {geo.country ? `Detected region: ${geo.country}. ` : ''}Signed in your own wallet; Afterbook never holds your funds and takes no fee on meme buys. The
        swap is built by KyberSwap and checked by the server field by field before your wallet sees it.
      </p>
    </>
  );
}
