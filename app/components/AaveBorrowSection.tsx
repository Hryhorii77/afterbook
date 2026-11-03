'use client';

import { useState } from 'react';
import type { GeoInfo } from '@/lib/geo';
import { AaveBorrowPanel, type AaveBorrowProps } from './AaveBorrowPanel';

// The /borrow page's in-app loan: the same gates as trading (a non-US region and the eligibility box,
// ticked each visit) in front of AaveBorrowPanel.
export function AaveBorrowSection({ geo, ...props }: AaveBorrowProps & { geo: GeoInfo }) {
  const [eligible, setEligible] = useState(false);
  const unlocked = geo.nonUs === true && eligible;
  return (
    <section className="panel" id="borrow-here">
      <h2>Borrow here with Aave</h2>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Post stock tokens as collateral and borrow USDC from Aave&apos;s Equities pool on Base, from your own wallet. Afterbook never holds your
        stock or the loan; it sends Aave&apos;s own contract calls for you to sign.
      </p>
      <label className="eligibility">
        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
        I confirm I am not a US person, am eligible under my local law to use tokenized equities, and understand my collateral is sold if its
        price falls far enough.
      </label>
      {unlocked ? (
        <AaveBorrowPanel {...props} />
      ) : (
        <p className={geo.nonUs === true ? 'geo-note' : 'geo-note geo-note-blocked'}>
          {geo.nonUs === true
            ? 'Tick the box to borrow.'
            : geo.country === 'US'
              ? "Borrowing is off in the United States: Coinbase's stock tokens aren't offered there."
              : "Borrowing is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it)."}
        </p>
      )}
    </section>
  );
}
