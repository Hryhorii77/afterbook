'use client';

// The Markets page (/markets and every /<SYMBOL> page): the hero with the active stock's gap, the
// gap history, the tape, the trade calculator and Execute. This file owns the page state (the
// active stock, the calculator size, the eligibility box) and the data; each section is its own
// component in ./markets/.
import { useMemo, useState } from 'react';
import { STOCKS } from '@/lib/tokens';
import type { TapeResult } from '@/lib/tape';
import { isLiquid, TAPE_MAIN_DEPTH_USD } from '@/lib/liquidity';
import type { GeoInfo } from '@/lib/geo';
import { bp, usdCompact } from '@/lib/format';
import { Sparkline } from './Sparkline';
import { useLotQuote, useNow, useSymbolData, useTapePoll, useTrend } from './markets/useMarketData';
import { MarketsHero } from './markets/MarketsHero';
import { TapeSection } from './markets/TapeSection';
import { LotLab } from './markets/LotLab';
import { ExecuteSection } from './markets/ExecuteSection';
import { MarketsFooter } from './markets/MarketsFooter';

function formatLogTime(ts: number): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(ts)) +
    ' ET'
  );
}

interface HomeClientProps {
  initialTape: TapeResult;
  initialGeo: GeoInfo;
  initialSymbol?: string;
}

export default function HomeClient({ initialTape, initialGeo, initialSymbol }: HomeClientProps) {
  const { tape, refreshFailed, eventLog } = useTapePoll(initialTape);
  const trend = useTrend();
  const now = useNow();
  const [geo] = useState<GeoInfo>(initialGeo);
  const [eligibleChecked, setEligibleChecked] = useState(false);
  const [symbol, setSymbol] = useState(initialSymbol ?? STOCKS[0].symbol);
  const [usdcInput, setUsdcInput] = useState('2500');

  const cashClosedAsOfMs =
    tape.session.state !== 'open' ? Math.max(0, ...tape.rows.map((r) => r.closeAsOfMs ?? 0)) : 0;
  const { quote, quoteError } = useLotQuote(symbol, usdcInput);
  const { history, depth, priceHistory, earningsStats, basisStats, openSnap } = useSymbolData(symbol, cashClosedAsOfMs);

  const unlocked = geo.nonUs === true && eligibleChecked;
  const activeStock = STOCKS.find((s) => s.symbol === symbol)!;
  const activeRow = tape.rows.find((r) => r.symbol === symbol);

  // Plain history API, not next/navigation's router.replace() — /[symbol]
  // is backed by an async Server Component (app/[symbol]/page.tsx) that
  // re-fetches getTape()/getGeoInfo() on every navigation. router.replace()
  // was triggering that full server round-trip on every single symbol
  // click even though this component already has everything it needs
  // client-side, and its arrival raced the scrollIntoView call below —
  // depending on network timing that produced anything from no scroll at
  // all, to a layout shift mid-scroll from the freshly-streamed data. A
  // plain URL update has no data fetch to race.
  const setSymbolAndUrl = (sym: string) => {
    setSymbol(sym);
    window.history.replaceState(null, '', `/${sym}`);
  };

  const selectSymbol = (sym: string) => {
    setSymbolAndUrl(sym);
    document.getElementById('lot-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Real, deep pools vs freshly-listed thin ones don't belong at the same
  // visual rank — a $10k pool's basis swings hundreds of bp on noise alone
  // and reads as "the tape is broken" next to NVDAc's single-digit bp.
  // The tape's two lists: main (pool at least TAPE_MAIN_DEPTH_USD) and smaller pools behind a toggle.
  const { liquidRows, thinRows } = useMemo(() => {
    const main = tape.rows.filter((r) => (r.depthUsd ?? 0) >= TAPE_MAIN_DEPTH_USD);
    return { liquidRows: main, thinRows: tape.rows.filter((r) => !main.includes(r)) };
  }, [tape.rows]);

  return (
    <main>
      <header className="home-intro">
        <h1>Stock prices on Base 24/7 next to the real market</h1>
        <p>
          Coinbase&apos;s stock tokens trade around the clock on Aero. See how far each one is from its real stock price
          and how much is really in its pool, then trade from your own wallet.
        </p>
      </header>

      <MarketsHero
        tape={tape}
        symbol={symbol}
        activeRow={activeRow}
        activeStock={activeStock}
        liquidRows={liquidRows}
        thinRows={thinRows}
        setSymbolAndUrl={setSymbolAndUrl}
      />

      {activeRow && !isLiquid(activeRow) && (
        <div className="thin-chip">thin book · {usdCompact(activeRow.depthUsd)} depth</div>
      )}

      {/* Hidden until there is something to draw: an empty "not enough history" panel read as broken. */}
      {(history.length >= 2 || basisStats || openSnap) && (
      <section className="panel">
        <h2>Basis since close · {activeStock.symbol}</h2>
        {history.length >= 2 && <Sparkline samples={history} />}
        {basisStats && (
          <p className="geo-note">
            Last 30 days (market closed): avg {bp(basisStats.meanBp)}, max {bp(basisStats.maxAbsBp)}, {basisStats.count}{' '}
            samples.
          </p>
        )}
        {openSnap && (
          <p className="geo-note">
            At 9:30 ET open, basis moved toward $0 within 30 min in {openSnap.revertedPct30.toFixed(0)}% of the last{' '}
            {openSnap.days30} sessions
            {openSnap.days90 > 0 && ` (${openSnap.revertedPct90.toFixed(0)}% within 90 min, ${openSnap.days90} sessions)`}.
          </p>
        )}
      </section>
      )}

      <TapeSection
        tape={tape}
        refreshFailed={refreshFailed}
        trend={trend}
        liquidRows={liquidRows}
        thinRows={thinRows}
        symbol={symbol}
        selectSymbol={selectSymbol}
      />

      {eventLog.length > 0 && (
        <section className="panel">
          <h2>Log</h2>
          <ul className="event-log">
            {eventLog.map((entry) => (
              <li key={entry.ts}>
                <span className="event-log-time">{formatLogTime(entry.ts)}</span> {entry.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      <LotLab
        tape={tape}
        symbol={symbol}
        setSymbolAndUrl={setSymbolAndUrl}
        activeRow={activeRow}
        activeStock={activeStock}
        liquidRows={liquidRows}
        thinRows={thinRows}
        usdcInput={usdcInput}
        setUsdcInput={setUsdcInput}
        quote={quote}
        quoteError={quoteError}
        depth={depth}
        priceHistory={priceHistory}
        earningsStats={earningsStats}
        now={now}
        unlocked={unlocked}
      />

      <ExecuteSection
        symbol={symbol}
        activeStock={activeStock}
        activeRow={activeRow}
        quote={quote}
        depth={depth}
        geo={geo}
        eligibleChecked={eligibleChecked}
        setEligibleChecked={setEligibleChecked}
        unlocked={unlocked}
      />

      <MarketsFooter activeStock={activeStock} />
    </main>
  );
}
