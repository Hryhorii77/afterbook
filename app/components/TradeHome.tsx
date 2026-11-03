'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { TapeResult, TapeRow } from '@/lib/tape';
import type { GeoInfo } from '@/lib/geo';
import { STOCKS, getStock, poolVenue } from '@/lib/tokens';
import { TAPE_MAIN_DEPTH_USD } from '@/lib/liquidity';
import { bpPct, formatNextOpen, usd } from '@/lib/format';
import { heroGapBp } from '@/lib/shareText';
import { SwapPanel } from './SwapPanel';
import { SymbolTile } from './SymbolTile';

// The home page (owner, 2026-11-03, from an external review): one sentence on what the site is,
// the market's state, the five deepest stocks and one action card (Swap, Borrow, Lend). The tape,
// the calculators and each stock's history moved to /markets. Swap is a real in-app trade (the same
// SwapPanel and eligibility check as before); Borrow links to the in-app Aave loan on /borrow (and
// Morpho's own site); Lend links to the in-app Aave deposit on /borrow#lend-here (and Aave's site).

const TOP_N = 5;
const AAVE_URL = 'https://app.aave.com/';
const MORPHO_URL = 'https://app.morpho.org/base/borrow';

type CardTab = 'swap' | 'borrow' | 'lend';

/** The real stock's price the gap is measured against, and what it is. Labels come from the row's
 *  data (cashPriceType), never from the clock alone (CLAUDE.md). */
function stockReference(row: TapeRow, state: string): { usd: number | null; label: string } {
  if (state === 'open') return { usd: row.cashLastUsd, label: 'Real stock' };
  const extended = row.cashPriceType === 'pre-market' || row.cashPriceType === 'after-hours';
  if (state.startsWith('closed') || !extended) return { usd: row.closeUsd ?? row.cashLastUsd, label: 'Real stock, last close' };
  return { usd: row.cashLastUsd, label: `Real stock, ${row.cashPriceType}` };
}

function gapClass(gapBp: number | null): string {
  return gapBp == null ? '' : gapBp >= 0 ? 'basis-pos' : 'basis-neg';
}

export default function TradeHome({
  initialTape,
  initialGeo,
  initialSymbol,
  lendApr,
}: {
  initialTape: TapeResult;
  initialGeo: GeoInfo;
  initialSymbol?: string;
  /** What lenders in Aave's Equities pool earn now (APR, before incentive programs); null if unread. */
  lendApr?: number | null;
}) {
  const [tape, setTape] = useState(initialTape);
  const geo = initialGeo;

  // Same 20 s refresh as the tape page; a failed fetch keeps the last good tape.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/tape');
        if (!res.ok) return;
        const next = (await res.json()) as TapeResult;
        if (alive && Array.isArray(next.rows) && next.rows.length > 0) setTape(next);
      } catch {
        // keep the last tape
      }
    };
    const id = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const state = tape.session.state;
  const rows = useMemo(() => [...tape.rows].sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0)), [tape.rows]);
  const top = rows.slice(0, TOP_N);
  const liquid = rows.filter((r) => (r.depthUsd ?? 0) >= TAPE_MAIN_DEPTH_USD);
  const thin = rows.filter((r) => !liquid.includes(r));

  const [symbol, setSymbol] = useState(() => initialSymbol ?? top[0]?.symbol ?? STOCKS[0].symbol);
  const [tab, setTab] = useState<CardTab>('swap');
  const [eligible, setEligible] = useState(false);
  const cardRef = useRef<HTMLElement>(null);

  // The prices and the swap below always describe the same stock: if a refresh drops the chosen
  // row, the card falls back to the first stock as a whole, never one stock's prices over another's swap.
  const chosen = tape.rows.find((r) => r.symbol === symbol);
  const row = chosen ?? top[0];
  const stock = row ? getStock(row.symbol) : undefined;
  const gap = row ? heroGapBp(row, tape.session) : null;
  const ref = row ? stockReference(row, state) : null;
  const unlocked = geo.nonUs === true && eligible;

  const buy = (sym: string) => {
    setSymbol(sym);
    setTab('swap');
    // On a phone the card sits under the list: bring it up. On desktop it is already beside it.
    if (window.matchMedia('(max-width: 900px)').matches) cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const others = Math.max(0, STOCKS.length - 3);
  const marketLine =
    state === 'open'
      ? `US stock market: open · ${tape.session.nyTime} ET`
      : `US stock market: ${tape.session.label.toLowerCase()} · opens ${formatNextOpen(tape.session.nextOpenIso)}`;

  return (
    <main className="trade-home">
      <div className="trade-home-grid">
        <div className="trade-home-main">
          <header className="trade-home-intro">
            <h1>Buy, borrow and earn with tokenized stocks on Base. 24/7.</h1>
            <p>
              Apple, Nvidia, Google and {others} more, priced next to the real stock market. Trade from your own wallet;
              Afterbook never holds your funds.
            </p>
            <p className="trade-home-status">
              <span className={`dot ${state}`} aria-hidden="true" />
              {marketLine}
            </p>
          </header>

          <section className="panel trade-top" aria-labelledby="top-stocks">
            <div className="trade-top-head">
              <h2 id="top-stocks">Top stocks on Base</h2>
              <span className="trade-top-note">Biggest pools first</span>
            </div>
            <table className="trade-top-table">
              <thead>
                <tr>
                  <th scope="col">Stock</th>
                  <th scope="col" className="num">On Base</th>
                  <th scope="col" className="num col-ref">Real stock</th>
                  <th scope="col" className="num">Gap</th>
                  <th scope="col">
                    <span className="sr-only">Buy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {top.map((r) => {
                  const g = heroGapBp(r, tape.session);
                  const rr = stockReference(r, state);
                  return (
                    <tr key={r.symbol} data-selected={r.symbol === symbol || undefined}>
                      <td>
                        <Link href={`/${r.symbol}`} className="trade-top-stock">
                          <SymbolTile cashTicker={r.cashTicker} />
                          <span>
                            <span className="trade-top-sym">{r.cashTicker}</span>
                            <span className="trade-top-name">{r.name}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="num">{usd(r.onchainMidUsd)}</td>
                      <td className="num col-ref">{usd(rr.usd)}</td>
                      <td className={`num ${gapClass(g)}`}>{bpPct(g)}</td>
                      <td className="trade-top-action">
                        <button type="button" className="btn btn-secondary" onClick={() => buy(r.symbol)} aria-label={`Buy ${r.cashTicker}`}>
                          Buy
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="trade-top-foot">
              Gap: how far the price on Base is from the real stock&apos;s. Green: the token costs more; red: less.
            </p>
            <Link href="/markets" className="page-link">
              See all {STOCKS.length}
              <span className="arrow">→</span>
            </Link>
          </section>
        </div>

        <aside className="panel action-card" ref={cardRef} aria-label="Swap, borrow or lend">
          <div className="carry-direction-toggle swap-side-toggle action-tabs" role="tablist" aria-label="What to do">
            {(['swap', 'borrow', 'lend'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? 'carry-direction-tab carry-direction-tab-active' : 'carry-direction-tab'}
                onClick={() => setTab(t)}
              >
                {t === 'swap' ? 'Swap' : t === 'borrow' ? 'Borrow' : 'Lend'}
              </button>
            ))}
          </div>

          {tab === 'swap' && row && stock && (
            <div role="tabpanel" aria-label="Swap">
              <label className="action-field">
                <span className="action-field-label">Stock</span>
                <select value={row.symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Stock">
                  <optgroup label="Deep pools">
                    {liquid.map((r) => (
                      <option key={r.symbol} value={r.symbol}>
                        {r.cashTicker} · {r.name}
                      </option>
                    ))}
                  </optgroup>
                  {thin.length > 0 && (
                    <optgroup label="Smaller pools">
                      {thin.map((r) => (
                        <option key={r.symbol} value={r.symbol}>
                          {r.cashTicker} · {r.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>

              <dl className="action-prices">
                <div>
                  <dt>On {poolVenue(stock)}</dt>
                  <dd>{usd(row.onchainMidUsd)}</dd>
                </div>
                <div>
                  <dt>{ref?.label}</dt>
                  <dd>{usd(ref?.usd ?? null)}</dd>
                </div>
                <div>
                  <dt>Gap</dt>
                  <dd className={gapClass(gap)}>{bpPct(gap)}</dd>
                </div>
              </dl>

              {geo.nonUs === true ? (
                <>
                  <label className="eligibility">
                    <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
                    I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
                  </label>
                  {unlocked ? (
                    <SwapPanel key={stock.symbol} stock={stock} />
                  ) : (
                    <p className="geo-note">Tick the box above to buy or sell {row.cashTicker}.</p>
                  )}
                </>
              ) : (
                <p className="geo-note geo-note-blocked">
                  {geo.country === 'US'
                    ? "Trading is off in the United States: Coinbase's stock tokens aren't offered there. Prices and everything else still work."
                    : "Trading is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). Prices and everything else still work."}
                </p>
              )}
              <p className="action-foot">
                Signed in your own wallet. The swap goes through KyberSwap&apos;s router, and Afterbook checks it before your wallet sees it.{' '}
                <Link href={`/${stock.symbol}`} className="emph-link">
                  {row.cashTicker} details
                </Link>
              </p>
            </div>
          )}

          {tab === 'borrow' && (
            <div role="tabpanel" aria-label="Borrow">
              <h2 className="action-title">Borrow USDC against your stock tokens</h2>
              <p className="geo-note" style={{ marginTop: 0 }}>
                Keep your stocks and borrow dollars against them on Aave, right here from your own wallet. See the health of the loan and
                the fall that would liquidate it before you sign.
              </p>
              <div className="basket-row">
                <Link href="/borrow#borrow-here" className="btn">
                  Borrow
                </Link>
                <Link href="/borrow#check" className="btn btn-secondary">
                  Check a loan
                </Link>
              </div>
              <p className="action-foot">
                In-app loans use Aave&apos;s Equities pool, which has the USDC to lend; Morpho&apos;s stock markets are on its own site. If
                the stock&apos;s price falls far enough, the loan is liquidated and you lose part of the stock.
              </p>
              <a href={MORPHO_URL} target="_blank" rel="noopener noreferrer" className="emph-link action-link">
                Open on Morpho&nbsp;<span className="ext-arrow">↗</span>
              </a>
            </div>
          )}

          {tab === 'lend' && (
            <div role="tabpanel" aria-label="Lend">
              <h2 className="action-title">Earn on idle USDC</h2>
              <p className="geo-note" style={{ marginTop: 0 }}>
                Lend USDC to people who borrow against stock tokens, and earn their interest. It goes into Aave&apos;s Equities pool on
                Base (not Aave&apos;s main USDC market), from your own wallet.{' '}
                {lendApr != null && lendApr > 0
                  ? `Lenders earn about ${(lendApr * 100).toFixed(1)}% a year right now; it changes with how much is borrowed.`
                  : 'You see the current rate before you deposit.'}
              </p>
              <div className="basket-row">
                <Link href="/borrow#lend-here" className="btn">
                  Lend
                </Link>
                <a href={AAVE_URL} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                  Open on Aave&nbsp;<span className="ext-arrow">↗</span>
                </a>
              </div>
              <p className="action-foot">
                It is not risk-free: withdrawals can wait while borrowers use most of the pool, and if a loan&apos;s stock can&apos;t be
                sold fast enough when its price falls, lenders can lose money.
              </p>
            </div>
          )}
        </aside>
      </div>

      <ol className="how-steps trade-home-steps" aria-label="How Afterbook works">
        <li>
          <span className="how-step-n">1</span>
          <span>
            <strong>See the price.</strong> Each stock&apos;s price on Base, next to the real stock&apos;s.
          </span>
        </li>
        <li>
          <span className="how-step-n">2</span>
          <span>
            <strong>Connect a wallet.</strong> Base Account works with a passkey, no seed phrase.
          </span>
        </li>
        <li>
          <span className="how-step-n">3</span>
          <span>
            <strong>Trade, borrow or lend.</strong> Every transaction is signed by you. No sign-up.
          </span>
        </li>
      </ol>

      <footer className="site-footer trade-home-footer">
        <div className="footer-links">
          <a href="https://x.com/hryhorii77" target="_blank" rel="noopener noreferrer">X</a>
          <a href="https://github.com/Hryhorii77/afterbook" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href="https://github.com/Hryhorii77/afterbook#readme" target="_blank" rel="noopener noreferrer">README</a>
        </div>
        <div className="footer-legal">
          <p>Not investment advice. Not available in the US.</p>
          <p>Company logos are the token icons published by Coinbase and belong to their owners. Afterbook is not affiliated with them.</p>
        </div>
      </footer>
    </main>
  );
}
