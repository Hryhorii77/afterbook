'use client';

// An agent's saved plan, or one the person asked the Telegram bot for (/plan/<id>, lib/agent/planLink.ts). The server ran the plan's checks again for this
// view; a buy is offered only where they still pass, at most the amount the agent was shown, through the
// normal swap panel (one stock) or basket buy (the whole basket, one signature with Base Account), behind
// the same region gate and eligibility box as /plan. Nothing is sent without the person's signature.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { GeoInfo } from '@/lib/server/geo';
import type { PlanLeg } from '@/lib/agent/plan';
import type { RecheckedBuy, SavedPlan, basketRecheck } from '@/lib/agent/planLink';
import { getStock } from '@/lib/stocks/tokens';
import { AUTO_PICK_HOLD } from '@/lib/agent/limits';
import { usd } from '@/lib/format';
import { SwapPanel } from '../swap/SwapPanel';
import { BasketBuyPanel } from '../baskets/BasketBuyPanel';
import { PlanLegCard } from './PlanLegCard';
import { PlanLinkShare } from './PlanLinkShare';

type Recheck = { legs: PlanLeg[]; checkedAt: number; buys: RecheckedBuy[]; basket: ReturnType<typeof basketRecheck> | null };
type Props =
  | { state: 'missing' | 'error' }
  | { state: 'ok'; saved: SavedPlan; recheck: Recheck | null; geo: GeoInfo };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const ticker = (sym: string) => getStock(sym)?.cashTicker ?? sym;

export function SavedPlanClient(props: Props) {
  if (props.state !== 'ok') {
    return (
      <main className="plan-page">
        <header className="top">
          <h1>{props.state === 'missing' ? 'Plan not found' : 'Couldn’t load this plan'}</h1>
        </header>
        <p className="plan-intro">
          {props.state === 'missing'
            ? 'This link has expired (plan links last 7 days) or isn’t complete. Ask for a new one (from the agent, or /plan in the Telegram bot), or make your own plan.'
            : 'The plan couldn’t be read just now. Reload the page in a moment.'}
        </p>
        <p className="geo-note">
          <Link href="/plan" className="page-link">
            Make your own plan<span className="arrow">→</span>
          </Link>
        </p>
      </main>
    );
  }
  return <SavedPlanView {...props} />;
}

function SavedPlanView({ saved, recheck, geo }: { saved: SavedPlan; recheck: Recheck | null; geo: GeoInfo }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  // Only the symbol is kept: the amount always comes from the latest recheck, so "Check again" can never
  // leave a panel open for a stock that stopped passing, or at an older, higher amount.
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [eligible, setEligible] = useState(false);
  const [buying, setBuying] = useState(false);
  // One buy per stock (and one basket) from this page: each closes once bought.
  const [bought, setBought] = useState<string[]>([]);
  const [basketBought, setBasketBought] = useState(false);
  const basket = saved.kind === 'basket' ? saved.brief : null;
  const selected: RecheckedBuy | undefined =
    selectedSymbol && !bought.includes(selectedSymbol) ? recheck?.buys.find((b) => b.symbol === selectedSymbol) : undefined;
  const selectedStock = selected ? getStock(selected.symbol) : undefined;
  // Who asked for it: an agent (x402, MCP) or the person themselves through the Telegram bot's /plan (2026-11-22).
  const byBot = saved.via === 'telegram';
  const shownTo = byBot ? 'the bot showed you' : 'the agent was shown';
  const basketStocks = (basket?.basket ?? []).map((l) => ({ symbol: l.symbol, decimals: getStock(l.symbol)?.decimals ?? 8 }));

  const gate = (buy: React.ReactNode) =>
    geo.nonUs === true ? (
      <>
        <label className="eligibility">
          <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} disabled={buying} />
          I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
        </label>
        {eligible ? buy : <p className="geo-note">Tick the box above to review the buy.</p>}
      </>
    ) : (
      <p className="geo-note geo-note-blocked">
        {geo.us
          ? "Trading is off in the United States: Coinbase's stock tokens aren't offered there. The plan itself still shows."
          : "Trading is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). The plan itself still shows."}
      </p>
    );

  return (
    <main className="plan-page">
      <header className="top">
        <h1>{basket ? 'Your basket' : 'Your plan'}</h1>
      </header>
      <p className="plan-intro">
        {byBot ? `You asked Afterbook’s Telegram bot for this ${basket ? 'basket' : 'plan'}.` : `An agent asked Afterbook for this ${basket ? 'basket' : 'plan'} and sent you the link.`} Afterbook’s code chose every stock and amount; the
        checks ran again when you opened this page, and you can buy only what still passes, once each on this visit, up to the amounts {shownTo}. Nothing is
        bought until you review a buy and sign it in your own wallet. This is a tool for your own decisions, not financial advice.
      </p>

      <PlanLinkShare title={basket ? 'A basket on Afterbook' : 'A plan on Afterbook'} />

      <section className="panel plan-result">
        <h2>Checked now</h2>
        <p className="plan-meta">
          <span suppressHydrationWarning>Made {when(saved.at)}</span>
          {recheck && (
            <>
              {' · '}
              <span suppressHydrationWarning>checked again {when(recheck.checkedAt)}</span>
            </>
          )}
        </p>
        <div className="basket-row">
          <button type="button" className="btn btn-secondary" disabled={refreshing || buying} onClick={() => startRefresh(() => router.refresh())}>
            {refreshing ? 'Checking…' : 'Check again'}
          </button>
        </div>

        {!recheck ? (
          <p className="geo-note geo-note-blocked" role="alert">
            The checks couldn’t run again just now, so buying is off. Try “Check again” in a moment.
          </p>
        ) : (
          <>
            <ul className="plan-legs">
              {recheck.legs.map((leg) => {
                const buy = recheck.buys.find((b) => b.symbol === leg.symbol);
                return (
                  <PlanLegCard key={leg.symbol} leg={leg}>
                    {buy && bought.includes(leg.symbol) && <p className="plan-hint">Bought from this page.</p>}
                    {!buy && leg.verdict === 'buy' && AUTO_PICK_HOLD[leg.symbol] && (
                      <p className="plan-hint">
                        <span className="trade-top-new">New listing</span> Not offered from a plan link while its pool settles; you can still buy it on its{' '}
                        <Link href={`/${leg.symbol}#execute`} className="emph-link">
                          own page
                        </Link>
                        .
                      </p>
                    )}
                    {buy && !bought.includes(leg.symbol) && (
                      <div className="basket-row">
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={buying}
                          onClick={() => {
                            setSelectedSymbol(buy.symbol);
                            requestAnimationFrame(() => document.getElementById('plan-link-buy')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                          }}
                        >
                          Review {usd(buy.usd, 0)} of {leg.symbol}
                        </button>
                      </div>
                    )}
                    {buy?.wasUsd != null && <p className="plan-hint">{byBot ? 'The bot showed you' : 'The agent was shown'} {usd(buy.wasUsd, 0)}; checked now, {usd(buy.usd, 0)} fits your limits.</p>}
                  </PlanLegCard>
                );
              })}
            </ul>

            {!basket && recheck.buys.length === 0 && (
              <p className="geo-note">Nothing in this plan passes its checks right now, so there is nothing to buy. Check again later, or make your own plan.</p>
            )}

            {!basket && selected && selectedStock && (
              <div className="plan-swap" id="plan-link-buy">
                <h3>
                  {selected.symbol} · at most {usd(selected.usd, 0)}
                </h3>
                <p className="geo-note">
                  The swap below gets a fresh quote and runs the usual checks. It starts at the plan’s amount and won’t go above it. If needed, your
                  wallet asks you to approve exactly the amount you review, then the swap (with Base Account, both in one signature).
                </p>
                {gate(
                  <SwapPanel
                    key={`${selected.symbol}-${selected.usd}`}
                    stock={selectedStock}
                    defaultUsd={selected.usd}
                    maxUsd={selected.usd}
                    maxLabel="This plan’s buy"
                    buyOnly
                    source={byBot ? 'telegram' : 'agent'}
                    onBuyStarted={() => setBuying(true)}
                    onBought={() => {
                      setBuying(false);
                      setBought((b) => [...b, selected.symbol]);
                      setSelectedSymbol(null);
                    }}
                    onBuyFailed={() => setBuying(false)}
                  />,
                )}
              </div>
            )}

            {basket && recheck.basket && (
              <div className="plan-swap" id="plan-link-buy">
                <h3>Review &amp; buy the basket</h3>
                {basketBought ? (
                  <p className="geo-note">Bought from this page. Your stocks are under Portfolio.</p>
                ) : recheck.basket.ok && basket.basket ? (
                  <>
                    <p className="geo-note">
                      {basket.basket.map((l) => `${ticker(l.symbol)} ${l.weightPct}%`).join(', ')}, at most {usd(recheck.basket.usd, 2)} in all. One
                      approval of exactly the total, then one swap per stock, each rebuilt and checked before you sign. With Base Account it is one
                      signature and goes through whole or not at all; other wallets sign each swap in turn and can stop partway.
                    </p>
                    {gate(
                      <BasketBuyPanel
                        key={`${saved.id}`}
                        legs={basket.basket}
                        stocks={basketStocks}
                        defaultUsd={recheck.basket.usd}
                        maxUsd={recheck.basket.usd}
                        maxLabel="This basket"
                        source={byBot ? 'telegram' : 'agent'}
                        onBusy={setBuying}
                        onRunDone={() => setBasketBought(true)}
                      />,
                    )}
                  </>
                ) : (
                  <>
                    <p className="geo-note">This basket doesn’t pass its checks right now, so it can’t be bought from this link:</p>
                    <ul className="plan-reasons">
                      {(recheck.basket.ok ? [] : recheck.basket.why).map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel">
        <details>
          <summary>
            {byBot ? 'What the bot showed you' : 'What the agent was shown'}, <span suppressHydrationWarning>{when(saved.at)}</span>
          </summary>
          <p className="plan-explanation">{saved.explanation}</p>
          <p className="plan-hint">
            {saved.explainedBy === 'claude' ? 'Explained by Claude from the numbers at the time.' : 'Explained in fixed words from the numbers at the time.'}{' '}
            Prices have moved since; the checks above are the ones that count.
          </p>
          {saved.kind === 'plan' ? (
            <ul className="plan-legs">
              {saved.plan.legs.map((leg) => (
                <PlanLegCard key={leg.symbol} leg={leg} />
              ))}
            </ul>
          ) : (
            <ul className="plan-reasons">
              {(saved.brief.picks ?? []).map((p) => (
                <li key={p.symbol}>
                  <strong>{ticker(p.symbol)}</strong>: {usd(p.usd, 0)}
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>

      <p className="geo-note">
        <Link href={basket ? '/plan#basket' : '/plan'} className="page-link">
          Make your own {basket ? 'basket' : 'plan'}
          <span className="arrow">→</span>
        </Link>
      </p>
    </main>
  );
}
