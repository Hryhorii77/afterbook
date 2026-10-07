import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Basket risks and terms — Afterbook',
  description: 'What Afterbook Basis Tilt is, how it works, and the ways you can lose money using it.',
};

const UPDATED = '2026-10-01';

export default function BasketRisksPage() {
  return (
    <main>
      <header className="top">
        <h1>Basket risks and terms</h1>
      </header>
      <p className="geo-note" style={{ marginTop: 0 }}>
        Read this before you put money into Basis Tilt. Last updated {UPDATED}. It describes how the product works today
        and will change as it does.
      </p>

      <section className="panel">
        <h2>What it is</h2>
        <p className="geo-note" style={{ marginTop: 0 }}>
          Basis Tilt is a strategy that holds ten Coinbase tokenized stocks on Base. Afterbook chooses the target weights.
          The trading itself is done by Glider, a third-party service, inside a smart account that you own. Afterbook
          never holds your funds and does not place your trades.
        </p>
      </section>

      <section className="panel">
        <h2>You can lose money</h2>
        <ul className="geo-note">
          <li>The tokens track stock prices, which fall as well as rise. Nothing here is guaranteed.</li>
          <li>
            The weighting is a hypothesis, not a proven edge. Half of it follows pool depth, and the other half follows the
            size of the gap between the cash price and the on-chain price. That gap usually shrinks by itself soon after the
            US market opens, so there is no evidence that tilting toward it earns more than holding the stocks equally.
          </li>
          <li>Afterbook is not investment advice, and nothing on this site is a recommendation to buy or sell.</li>
        </ul>
      </section>

      <section className="panel">
        <h2>Trading costs</h2>
        <ul className="geo-note">
          <li>
            Deposits are swapped into the stocks, and withdrawals as USDC are swapped back out. Swaps run through Aerodrome
            using LI.FI, and these pools are small. In our own test, buying and selling about $5 across three liquid names
            cost roughly 0.9% in total. Thinner names in the full basket can cost more, and a larger deposit moves the price
            more.
          </li>
          <li>
            The strategy is set to a 1% slippage limit, a 1% price-impact limit, and a $1 minimum per trade. A position
            smaller than $1 is not bought, so small deposits can leave some names unfilled.
          </li>
          <li>
            The target weights are updated at most about once a day, and only when at least 10% of the basket would change.
            When they change, every enrolled account trades toward the new weights and pays those costs again.
          </li>
          <li>You also pay network gas for your own transactions on Base.</li>
        </ul>
      </section>

      <section className="panel">
        <h2>The tokens are not shares</h2>
        <ul className="geo-note">
          <li>
            Each token is Coinbase&apos;s claim about a stock position, issued on Base. Afterbook cannot verify the reserves
            behind them. Coinbase can change how the tokens work, including splits and dividend adjustments.
          </li>
          <li>
            The tokens trade around the clock, but the cash market does not. Outside US market hours the on-chain price can
            sit well away from the cash price, and the pools are thinner.
          </li>
          <li>
            Afterbook is independent. It is not affiliated with Coinbase, Base, Glider, or any of the companies whose stocks
            are tracked.
          </li>
        </ul>
      </section>

      <section className="panel">
        <h2>Who controls what</h2>
        <ul className="geo-note">
          <li>
            Your funds sit in a smart account on Base that you own. According to Glider&apos;s documentation, Glider&apos;s
            automation can rebalance that account within the strategy, but cannot withdraw to another address without a fresh
            signature from you.
          </li>
          <li>
            If Glider&apos;s service were interrupted, you would still own the account, but getting funds out might need
            technical steps, and we cannot promise it would be quick or possible.
          </li>
          <li>
            Glider and Afterbook are separate. Afterbook cannot move your funds, pause your account, or recover a lost
            wallet.
          </li>
        </ul>
      </section>

      <section className="panel">
        <h2>Software risk</h2>
        <p className="geo-note" style={{ marginTop: 0 }}>
          Afterbook is new software built by one person and has not had an independent security audit. A bug in Afterbook,
          Glider, LI.FI, Aerodrome or the tokens themselves could cost you money or stop a withdrawal. Start with an amount
          you can afford to lose.
        </p>
      </section>

      <section className="panel">
        <h2>Availability and who runs it</h2>
        <ul className="geo-note">
          <li>
            Baskets are not available to people in the United States. The check uses your IP address, is a best-effort
            filter and not a compliance control, and does not stop a VPN. Using a VPN to get around it does not make it
            permitted. You are responsible for following the laws where you live, which may restrict this product even
            outside the US.
          </li>
          <li>
            Afterbook is operated by an individual and is not a registered company at this time, so there is no company
            standing behind it.
          </li>
          <li>
            Afterbook currently charges no fee for baskets. Glider, LI.FI, Aerodrome and the network may charge their own
            fees. Any change to ours will be shown on this page.
          </li>
        </ul>
      </section>

      <p className="geo-note">
        <Link href="/baskets" className="page-link">
          <span className="arrow" style={{ transform: 'none' }}>←</span> Back to Baskets
        </Link>
      </p>
    </main>
  );
}
