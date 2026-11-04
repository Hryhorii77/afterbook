'use client';

import { useEffect, useState } from 'react';
import type { GeoInfo } from '@/lib/server/geo';
import { AaveLendPanel, type AaveLendProps } from './AaveLendPanel';

// The /borrow page's in-app lending: the same gates as trading and borrowing (a non-US region and the
// eligibility box, ticked each visit) in front of AaveLendPanel.
export function AaveLendSection({ geo, ...props }: AaveLendProps & { geo: GeoInfo }) {
  const [eligible, setEligible] = useState(false);
  // A link from another page (the home card) navigates client-side while a loading placeholder is up, so
  // the browser's own jump to #lend-here finds nothing; scroll here once mounted.
  useEffect(() => {
    if (window.location.hash === '#lend-here') document.getElementById('lend-here')?.scrollIntoView();
  }, []);
  const unlocked = geo.nonUs === true && eligible;
  return (
    <section className="panel" id="lend-here">
      <h2>Lend USDC with Aave</h2>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Deposit USDC into Aave&apos;s Equities pool on Base, the pool the loans above borrow from, and earn their interest. Afterbook
        never holds your USDC; it sends Aave&apos;s own contract calls for you to sign.
      </p>
      <label className="eligibility">
        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
        I confirm I am not a US person, am eligible under my local law to use this, and understand I can lose part of what I lend and may
        have to wait to withdraw.
      </label>
      {unlocked ? (
        <AaveLendPanel {...props} />
      ) : (
        <p className={geo.nonUs === true ? 'geo-note' : 'geo-note geo-note-blocked'}>
          {geo.nonUs === true
            ? 'Tick the box to lend.'
            : geo.country === 'US'
              ? "Lending here is off in the United States, like trading and borrowing. Money already lent can always be withdrawn in Aave's own app."
              : "Lending is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). Money already lent can always be withdrawn in Aave's own app."}
        </p>
      )}
    </section>
  );
}
