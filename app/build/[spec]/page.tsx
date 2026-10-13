import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SymbolTile } from '@/app/components/SymbolTile';
import { SessionPill } from '@/app/components/SessionPill';
import { ShareButton } from '@/app/components/ShareButton';
import { BasketPicker } from '@/app/components/BasketPicker';
import { getTape } from '@/lib/tape';
import { isLiquid } from '@/lib/liquidity';
import { STOCKS, getStock } from '@/lib/tokens';
import { parseSpec, formatSpec, basketLabel, basketGapBp, basketReferenceLabel, legGapBp } from '@/lib/customBasket';
import { getBasketCost, MAX_COST_BP } from '@/lib/basketCost';
import { bp, usd, usdCompact, gapSizeText, formatNextOpen } from '@/lib/format';
import { shareMetadata } from '@/lib/shareMeta';
import { basketShareText } from '@/lib/shareText';

// Live tape and pool reads on every request (each cached 20–60s
// underneath), same as /today and /borrow.
export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ spec: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const legs = parseSpec((await params).spec);
  if (!legs) return {};
  const spec = formatSpec(legs);
  return shareMetadata({
    title: `${basketLabel(legs)} — Afterbook basket`,
    description: `How far this basket of Base tokenized stocks (${basketLabel(legs)}) trades from the cash market, and what it costs to buy on Aerodrome.`,
    path: `/build/${spec}`,
    card: { page: 'build', spec },
    searchParams: await searchParams,
  });
}

export default async function BuildPage({ params }: PageProps) {
  const { spec } = await params;
  const legs = parseSpec(spec);
  if (!legs) notFound();
  const canonical = formatSpec(legs);

  const [tape, cost] = await Promise.all([getTape().catch(() => null), getBasketCost(legs).catch(() => null)]);
  const state = tape?.session.state ?? 'open';
  const rows = tape?.rows ?? [];
  const gap = tape ? basketGapBp(legs, rows, state) : null;
  const reference = tape ? basketReferenceLabel(legs, rows, state) : 'the cash price';
  const marketOpen = state === 'open';

  const symbols = [...STOCKS]
    .map((s) => {
      const row = rows.find((r) => r.symbol === s.symbol);
      return { symbol: s.symbol, thin: row ? !isLiquid(row) : false, depth: row?.depthUsd ?? 0 };
    })
    .sort((a, b) => Number(a.thin) - Number(b.thin) || b.depth - a.depth)
    .map(({ symbol, thin }) => ({ symbol, thin }));

  const shareText = basketShareText(legs, gap, reference);

  return (
    <main>
      <header className="top">
        <h1>Build a basket</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Pick 2 to 4 of the tokenized stocks and how much of each. See how far the basket trades from the cash market on
        Aerodrome (the on-chain exchange), and what it would cost to buy. Read-only: nothing is bought here.
      </p>

      <section className="panel gap-hero today-hero">
        <div className="today-top">
          <div className="sym-cell-text">
            <span className="today-id-label">Your basket</span>
            <span className="symbol">{basketLabel(legs)}</span>
          </div>
          {tape && <SessionPill state={tape.session.state} label={tape.session.label} nyTime={tape.session.nyTime} />}
        </div>

        <div className="today-stats">
          <div className="stat-card stat-card-hero">
            <div className="stat-label" style={{ marginTop: 0 }}>
              Gap, Aero vs cash
            </div>
            <div className={`today-stat-value ${gap != null && gap >= 0 ? 'basis-pos' : 'basis-neg'}`}>{bp(gap)}</div>
            <div className="stat-label">
              {gap == null
                ? 'One of these stocks has no reading yet.'
                : `On Aerodrome this basket is ${gapSizeText(gap)} ${gap >= 0 ? 'above' : 'below'} ${reference}.`}
              {!marketOpen && tape ? ` Cash reopens ${formatNextOpen(tape.session.nextOpenIso)}.` : ''} 100 bp = 1%.
            </div>
          </div>
          {cost && (
            <>
              <div className="stat-card">
                <div className="stat-value">{cost.points[1].costBp.toFixed(1)} bp</div>
                <div className="stat-label">Cost to buy {usdCompact(cost.points[1].usd)} of it, fees included</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {cost.maxIsLowerBound ? '> ' : ''}
                  {usdCompact(cost.maxUsdUnderCap)}
                </div>
                <div className="stat-label">Largest buy under {MAX_COST_BP / 100}% total cost</div>
              </div>
            </>
          )}
        </div>

        <div className="hero-actions">
          <ShareButton
            path={`/build/${canonical}`}
            card={{ page: 'build', spec: canonical }}
            fileName={`afterbook-basket-${legs.map((l) => l.symbol).join('-')}.png`}
            text={shareText}
          />
        </div>
      </section>

      <section className="panel">
        <h2>Change it</h2>
        <BasketPicker key={canonical} symbols={symbols} initial={legs} />
      </section>

      <section className="panel">
        <h2>The stocks in it</h2>
        <div className="weight-grid">
          {legs.map((leg) => {
            const stock = getStock(leg.symbol)!;
            const row = rows.find((r) => r.symbol === leg.symbol);
            const legGap = row ? legGapBp(row, state) : null;
            const legCost = cost?.legsAtMid.find((l) => l.symbol === leg.symbol);
            return (
              <div className="weight-card" key={leg.symbol}>
                <div className="weight-card-top">
                  <SymbolTile cashTicker={stock.cashTicker} />
                  <div className="sym-cell-text">
                    <span className="symbol">{stock.symbol}</span>
                    <span className="symbol-name" title={stock.name}>
                      {stock.name}
                    </span>
                  </div>
                </div>
                <div className="weight-pct">{leg.weightPct}%</div>
                <div className="weight-bar" aria-hidden="true">
                  <span style={{ width: `${leg.weightPct}%` }} />
                </div>
                <div className="weight-meta">
                  <span>Gap</span>
                  <span className={legGap != null && legGap >= 0 ? 'basis-pos' : 'basis-neg'}>{bp(legGap)}</span>
                </div>
                <div className="weight-meta">
                  <span>Adds to basket gap</span>
                  <span>{legGap == null ? '—' : bp((legGap * leg.weightPct) / 100)}</span>
                </div>
                <div className="weight-meta">
                  <span>Aero price</span>
                  <span>{usd(row?.onchainMidUsd ?? null)}</span>
                </div>
                {legCost && (
                  <div className="weight-meta">
                    <span>Cost of its {usdCompact(legCost.usd)}</span>
                    <span>{legCost.costBp.toFixed(1)} bp</span>
                  </div>
                )}
                <div className="weight-meta">
                  <Link className="emph-link" href={`/${stock.symbol}#lot-lab`}>
                    Size it in Lot Lab
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {cost && (
        <section className="panel">
          <h2>What it costs to buy</h2>
          <div className="stat-grid" style={{ marginTop: 0 }}>
            {cost.points.map((p) => (
              <div className="stat-card" key={p.usd}>
                <div className="stat-value">
                  {p.exhaustedWindow ? '> ' : ''}
                  {p.costBp.toFixed(1)} bp
                </div>
                <div className="stat-label">To buy {usdCompact(p.usd)} of the basket</div>
              </div>
            ))}
          </div>
          <p className="geo-note">
            The cost is how far your average price would sit above the Aerodrome price, including the 0.05% pool fee,
            with each stock&apos;s share of the money walked through that pool&apos;s real liquidity right now. It does not
            include network gas, and prices move between now and when you trade.
          </p>
        </section>
      )}

      <section className="panel">
        <h2>Good to know</h2>
        <ul className="geo-note">
          <li>
            The basket gap is the weighted average of each stock&apos;s gap. It tells you whether the basket is cheap or
            dear on-chain compared with the stock market, not whether it is a good buy.
          </li>
          <li>
            Nothing here rebalances or holds anything. For a basket that is bought and rebalanced for you, see{' '}
            <Link className="emph-link" href="/baskets">
              Baskets
            </Link>
            .
          </li>
          <li>Not advice. Coinbase&apos;s stock tokens are not available to people in the United States.</li>
        </ul>
      </section>
    </main>
  );
}
