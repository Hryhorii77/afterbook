// /traction (2026-11-21): what people actually signed through Afterbook. Every swap counted was found
// onchain carrying Afterbook's Builder Code and matched to a swap Afterbook's server built (lib/swap/swapLog.ts);
// Afterbook's own test wallets are left out and the page says how many. Numbers come from the data cache,
// refreshed at most hourly (lib/swap/traction.ts).
import Link from 'next/link';
import { getTraction } from '@/lib/swap/traction';
import type { SwapSource, SwapStats } from '@/lib/swap/swapLog';
import { usd } from '@/lib/format';
import { shareMetadata } from '@/lib/share/shareMeta';

export const dynamic = 'force-dynamic';

export const metadata = shareMetadata({
  title: 'Traction — Afterbook',
  description: 'Swaps signed through Afterbook on Base, each found onchain with its Builder Code, test wallets left out.',
  path: '/traction',
  card: { page: 'home' },
});

const SOURCES: { key: SwapSource; label: string; note: string }[] = [
  { key: 'agent', label: 'From an agent’s plan link', note: 'An agent made a plan (free over MCP, or paid over x402); a person opened its link and signed' },
  { key: 'plan', label: 'Trade plan', note: '/plan, checked by the code, signed by the person' },
  { key: 'rule', label: 'Stock rules', note: 'A recurring buy, signed on each run' },
  { key: 'basket', label: 'Baskets', note: 'Several stocks in one go (/build and Describe a basket)' },
  { key: 'stock', label: 'Single stock', note: 'The swap on the home page and stock pages' },
  { key: 'meme', label: 'Memestocks', note: 'Base memes priced in stock tokens' },
];

const date = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const num = (n: number) => n.toLocaleString('en-US');

function Totals({ s, title }: { s: SwapStats; title: string }) {
  return (
    <>
      <h2>{title}</h2>
      <div className="stat-grid traction-grid">
        <div className="stat-card">
          <div className="stat-value">{num(s.swaps)}</div>
          <div className="stat-label">Swaps signed</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{usd(s.volumeUsd, 0)}</div>
          <div className="stat-label">Volume</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{num(s.traders)}</div>
          <div className="stat-label">Wallets</div>
        </div>
      </div>
    </>
  );
}

export default async function TractionPage() {
  const t = await getTraction().catch(() => null);
  return (
    <main>
      <header className="top">
        <h1>Traction</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        What people signed through Afterbook on Base. Each swap here was found onchain carrying Afterbook&apos;s Builder Code and matched to a
        swap Afterbook&apos;s server built and checked; Afterbook&apos;s own test wallets are left out.
      </p>

      {!t ? (
        <section className="panel">
          <p className="geo-note geo-note-blocked">The numbers couldn&apos;t be read just now. Try again in a while.</p>
        </section>
      ) : (
        <>
          <section className="panel">
            <Totals s={t.month} title="Last 30 days" />
          </section>
          <section className="panel">
            <Totals s={t.all} title={t.sinceMs ? `Since ${date(t.sinceMs)}` : 'All time'} />
          </section>

          <section className="panel">
            <h2>Where the swaps came from</h2>
            <div className="traction-scroll">
              <table className="traction-table">
                <thead>
                  <tr>
                    <th scope="col">From</th>
                    <th scope="col">Swaps, 30 days</th>
                    <th scope="col">Swaps, all</th>
                    <th scope="col">Volume, all</th>
                  </tr>
                </thead>
                <tbody>
                  {SOURCES.map((src) => (
                    <tr key={src.key}>
                      <th scope="row">
                        {src.label}
                        <span className="traction-note">{src.note}</span>
                      </th>
                      <td>{num(t.month.bySource[src.key].swaps)}</td>
                      <td>{num(t.all.bySource[src.key].swaps)}</td>
                      <td>{usd(t.all.bySource[src.key].volumeUsd, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <h2>Agents</h2>
            <p className="geo-note" style={{ marginTop: 0 }}>
              Agents make a checked plan, free over MCP or paid over x402 in USDC on Base, and get a link; a person opens it on Afterbook and signs
              each buy in their own wallet.
              {t.paidPlans30 != null && (
                <>
                  {' '}
                  Plans paid for in the last 30 days: <strong>{num(t.paidPlans30)}</strong> (plans carry no wallet, so this includes Afterbook&apos;s own tests).
                </>
              )}
            </p>
            <p className="geo-note">
              Swaps signed from an agent&apos;s plan link: <strong>{num(t.all.bySource.agent.swaps)}</strong> ({usd(t.all.bySource.agent.volumeUsd, 0)}).
            </p>
          </section>

          <p className="geo-note">
            Left out as Afterbook&apos;s own tests: {num(t.all.testsLeftOut?.swaps ?? 0)} swaps ({usd(t.all.testsLeftOut?.volumeUsd ?? 0, 0)}). A swap from a
            smart account counts only from a genuine Coinbase Smart Wallet (Base Account). Updated at most hourly.{' '}
            <Link href="/more" className="emph-link">
              More
            </Link>
          </p>
        </>
      )}
    </main>
  );
}
