// /agents (2026-11-25, for the Stocks Maxxing quest): how an agent uses Afterbook. The free MCP server and the paid
// x402 routes, on one page instead of only in the README. The rule throughout: the agent proposes, Afterbook's code
// checks, the person signs. Nothing here gives an agent a key, a wallet or a way to sign. Static text; every tool,
// route and price is the code's own (app/api/mcp/route.ts, app/api/v1/x402/*, lib/server/x402.ts).
import Link from 'next/link';
import { shareMetadata } from '@/lib/share/shareMeta';
import { X402_PRICE, X402_PRICE_PREMIUM } from '@/lib/server/x402';

export const metadata = shareMetadata({
  title: 'Afterbook for agents',
  description: 'Free MCP tools and paid x402 routes for Coinbase tokenized stocks on Base. The agent proposes, the code checks, the person signs.',
  path: '/agents',
  card: { page: 'agents' },
});

const MCP_URL = 'https://afterbook.app/api/mcp';

const TOOLS: { name: string; does: string }[] = [
  { name: 'make_plan', does: 'A checked buy, wait or skip per stock, sized within your cost limit, $25k and 10% of the pool, plus planUrl: a link a person opens to sign.' },
  { name: 'make_basket', does: 'A 2–4 stock basket from a theme or sectors, the deepest steady pools that pass, plus buyUrl to sign it.' },
  { name: 'check_loan_health', does: 'A wallet’s Aave and Morpho stock loans: health now and if the next open matches Base’s price (weekends, holidays).' },
  { name: 'make_rescue_link', does: 'For an Aave loan, a link that opens Afterbook’s rescue planner set to repay or add collateral. No amount, no wallet in the link.' },
  { name: 'get_tape', does: 'Every tracked stock: the token’s onchain price on Aero against the real stock, the gap in bp, and real pool depth.' },
  { name: 'get_quote', does: 'Shares out, price and impact for a USDC buy of a given size, from the pool’s own liquidity.' },
  { name: 'get_basis_stats', does: 'How wide the gap usually gets while the cash market is shut, over 30 days.' },
];

const PAID: { route: string; price: string; does: string }[] = [
  { route: '/api/v1/x402/plan', price: X402_PRICE_PREMIUM, does: 'make_plan with Claude’s plain explanation of the checked plan, plus planUrl' },
  { route: '/api/v1/x402/basket', price: X402_PRICE_PREMIUM, does: 'make_basket, explained, plus buyUrl' },
  { route: '/api/v1/x402/loan-health', price: X402_PRICE, does: 'check_loan_health, for agents that already pay over x402' },
  { route: '/api/v1/x402/history', price: X402_PRICE_PREMIUM, does: '30 days of gap history plus the pool’s liquidity' },
  { route: '/api/v1/x402/lp-range', price: X402_PRICE_PREMIUM, does: 'A liquidity range sized from realized volatility' },
  { route: '/api/v1/x402/liquidation-capacity', price: X402_PRICE_PREMIUM, does: 'A stock’s borrow markets, the onchain-vs-oracle gap and the largest liquidation its pool can absorb' },
  { route: '/api/v1/x402/tape', price: X402_PRICE, does: 'get_tape, without an API key' },
  { route: '/api/v1/x402/quote', price: X402_PRICE, does: 'get_quote, without an API key' },
  { route: '/api/v1/x402/execute-link', price: X402_PRICE, does: 'A link to the stock’s own page on Afterbook to buy it' },
];

const EXAMPLE = `→ make_plan { "symbols": ["NVDAc"], "budgetUsd": 100 }

← { "plan": { "legs": [ { "symbol": "NVDAc", "verdict": "buy",
       "usd": 100, "costBp": 3.4, "gapBp": -2.2 } ] },
     "planUrl": "https://afterbook.app/plan/…" }`;

export default function AgentsPage() {
  return (
    <main className="plan-page">
      <header className="top">
        <h1>Afterbook for agents</h1>
      </header>
      <p className="plan-intro">
        Your agent can plan trades in Coinbase&apos;s tokenized stocks on Base, check loans and hand a person a link to act. The agent proposes,
        Afterbook&apos;s code checks every number, and the person signs in their own wallet. No agent ever gets a key, a wallet or a way to sign.
      </p>

      <section className="panel">
        <h2>Connect, free</h2>
        <p className="geo-note" style={{ marginTop: 0 }}>
          A remote MCP server, no key and no sign-up. Rate-limited per caller; plan links last 7 days.
        </p>
        <h3>Claude Code</h3>
        <pre className="agent-code">
          <code>claude mcp add --transport http afterbook {MCP_URL}</code>
        </pre>
        <h3>Claude Desktop and claude.ai</h3>
        <p className="geo-note">
          Settings → Connectors → Add custom connector, and paste <code>{MCP_URL}</code>.
        </p>
        <h3>Any MCP client</h3>
        <p className="geo-note">
          Streamable HTTP at <code>{MCP_URL}</code>.
        </p>
      </section>

      <section className="panel">
        <h2>Seven tools</h2>
        <div className="agent-table-wrap">
          <table className="agent-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>What it gives back</th>
              </tr>
            </thead>
            <tbody>
              {TOOLS.map((t) => (
                <tr key={t.name}>
                  <td>
                    <code>{t.name}</code>
                  </td>
                  <td>{t.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="geo-note">None of the seven builds or signs a transaction. They read public data; make_plan and make_basket also save the plan so its link works for 7 days.</p>
      </section>

      <section className="panel">
        <h2>From a plan to a signed buy</h2>
        <pre className="agent-code">
          <code>{EXAMPLE}</code>
        </pre>
        <ol className="agent-steps">
          <li>Your agent calls make_plan. Afterbook&apos;s code decides each verdict and size; nothing comes from a model.</li>
          <li>It passes planUrl to the person, in chat or anywhere.</li>
          <li>The person opens it on Afterbook. The checks run again on live prices, and only what still passes is offered, never more than the plan showed.</li>
          <li>They connect their own wallet and sign. With Base Account the approval and the swap are one signature, tried on Base first.</li>
        </ol>
        <p className="geo-note">
          The same plans come from the Telegram bot: send <code>/plan NVDA 100</code> to{' '}
          <a className="emph-link" href="https://t.me/afterbook_bot" target="_blank" rel="noopener noreferrer">
            @afterbook_bot&nbsp;<span className="ext-arrow">↗</span>
          </a>
          .
        </p>
      </section>

      <section className="panel">
        <h2>Pay per call, x402</h2>
        <p className="geo-note" style={{ marginTop: 0 }}>
          For agents that pay their own way: USDC on Base per call over{' '}
          <a className="emph-link" href="https://x402.org" target="_blank" rel="noopener noreferrer">
            x402&nbsp;<span className="ext-arrow">↗</span>
          </a>
          , no key.
        </p>
        <div className="agent-table-wrap">
          <table className="agent-table">
            <thead>
              <tr>
                <th>Route</th>
                <th className="num">Price</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {PAID.map((r) => (
                <tr key={r.route}>
                  <td>
                    <code>{r.route}</code>
                  </td>
                  <td className="num">{r.price}</td>
                  <td>{r.does}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>What an agent can&apos;t do</h2>
        <ul className="agent-steps">
          <li>Sign, send or approve anything: every link ends with a person signing in their own wallet.</li>
          <li>Pick amounts past the checks: the code caps every buy at $25,000, 10% of the pool and your cost limit.</li>
          <li>Put its own numbers in a link: a link carries only what the code decided, and the page checks it again.</li>
          <li>Trade for US persons: buying is off in the US and its territories.</li>
        </ul>
        <p className="geo-note">
          <Link href="/traction" className="page-link">
            What people signed so far<span className="arrow">→</span>
          </Link>
        </p>
      </section>
    </main>
  );
}
