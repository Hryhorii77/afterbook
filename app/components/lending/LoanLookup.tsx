'use client';

// "Look up a wallet's stock loans" on /borrow (2026-11-26): any address or Basename, without connecting. The same
// read as the free MCP tool check_loan_health (/api/loans, lib/lending/loanReport.ts): health at the lender's price and
// at Base's, and how far the collateral could fall. Read-only: no rescue links here (they fill the panel from the
// connected wallet's own loan, so they only make sense for your own), and nothing can sign.
import { useRef, useState } from 'react';
import { WalletLookup, type LookedUp } from '../wallet/WalletLookup';
import { usd } from '@/lib/format';

interface ReportLoan {
  venue: 'aave' | 'morpho';
  collateral: { symbol: string }[];
  debtUsd: number;
  healthFactor: number | null;
  healthAtAero: number | null;
  dropToLiquidation: number | null;
}

const hf = (n: number | null) => (n == null ? '—' : Number.isFinite(n) ? n.toFixed(2) : 'no debt');
const VENUE = { aave: 'Aave', morpho: 'Morpho' } as const;

export function LoanLookup() {
  const [wallet, setWallet] = useState<LookedUp | null>(null);
  const [loans, setLoans] = useState<ReportLoan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only the latest lookup may set what's shown (review of #247): a slow earlier answer landing after a newer lookup
  // showed one wallet's loans under another's name.
  const latest = useRef(0);
  const found = async (w: LookedUp) => {
    const id = ++latest.current;
    setWallet(w);
    setLoans(null);
    setError(null);
    try {
      const res = await fetch(`/api/loans?address=${w.address}`);
      const json = (await res.json()) as { loans?: ReportLoan[]; error?: string };
      if (id !== latest.current) return;
      if (!res.ok || !json.loans) setError(res.status === 429 ? 'Too many lookups. Try again in a minute.' : 'Couldn’t read Aave and Morpho just now. Try again.');
      else setLoans(json.loans);
    } catch {
      if (id === latest.current) setError('Couldn’t read Aave and Morpho just now. Try again.');
    }
  };
  const who = wallet ? wallet.name ?? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}` : '';

  return (
    <section className="panel" id="look-up-loans">
      <h2>Look up a wallet&apos;s stock loans</h2>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Any wallet&apos;s Aave and Morpho loans against stock tokens on Base, read-only, no connecting. &quot;Base price&quot; is the loan&apos;s health at Base&apos;s price,
        where the lender&apos;s may go when the cash market moves; &quot;Room&quot; is how far the collateral can fall before liquidation, which starts below 1.00.
      </p>
      <WalletLookup onFound={found} label="Address or Basename" />
      {error && <p className="geo-note" role="alert">{error}</p>}
      {wallet && loans && loans.length === 0 && <p className="geo-note">{who} has no Aave or Morpho stock loans on Base right now.</p>}
      {wallet && loans && loans.length > 0 && (
        <div className="traction-scroll">
          <table className="traction-table loan-lookup-table">
            <caption className="geo-note" style={{ textAlign: 'left', captionSide: 'top' }}>
              {who}
            </caption>
            <thead>
              <tr>
                <th scope="col">Loan</th>
                <th scope="col">Borrowed</th>
                <th scope="col">Health</th>
                <th scope="col">Base price</th>
                <th scope="col">Room</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l, i) => (
                <tr key={i}>
                  <th scope="row">
                    {VENUE[l.venue]} · {l.collateral.map((c) => c.symbol).join(' + ')}
                  </th>
                  <td>{usd(l.debtUsd)}</td>
                  <td>{hf(l.healthFactor)}</td>
                  <td>{hf(l.healthAtAero)}</td>
                  <td>{l.dropToLiquidation == null ? '—' : `${Math.round(l.dropToLiquidation * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="loan-lookup-hint geo-note">Swipe for more →</p>
        </div>
      )}
    </section>
  );
}
