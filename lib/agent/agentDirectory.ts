// What an agent can use on Afterbook (2026-11-25): the free MCP tools, the free API key and the paid x402 routes, in
// one place so /agents and /llms.txt say the same thing. Every tool, route and price is the code's own
// (app/api/mcp/route.ts, app/api/v1/*, lib/server/x402.ts).
import { X402_PRICE, X402_PRICE_PREMIUM } from '../server/x402';

export const MCP_URL = 'https://afterbook.app/api/mcp';

export const TOOLS: { name: string; does: string }[] = [
  { name: 'make_plan', does: 'A checked buy, wait or skip per stock, sized within your cost limit, $25k and 10% of the pool, plus planUrl: a link a person opens to sign.' },
  { name: 'make_basket', does: 'A 2–4 stock basket from a theme or sectors, the deepest steady pools that pass, plus buyUrl to sign it.' },
  { name: 'check_loan_health', does: 'A wallet’s Aave and Morpho stock loans: health now and if the next open matches Base’s price (weekends, holidays).' },
  { name: 'make_rescue_link', does: 'For an Aave loan, a link that opens Afterbook’s rescue planner set to repay or add collateral. No amount, no wallet in the link.' },
  { name: 'get_tape', does: 'Every tracked stock: the token’s onchain price on Aero against the real stock, the gap in bp, and real pool depth.' },
  { name: 'get_quote', does: 'Shares out, price and impact for a USDC buy of a given size, from the pool’s own liquidity.' },
  { name: 'get_basis_stats', does: 'How wide the gap usually gets while the cash market is shut, over 30 days.' },
];

export const PAID: { route: string; price: string; does: string }[] = [
  { route: '/api/v1/x402/plan', price: X402_PRICE_PREMIUM, does: 'make_plan with Claude’s plain explanation of the checked plan, plus planUrl' },
  { route: '/api/v1/x402/basket', price: X402_PRICE_PREMIUM, does: 'make_basket, explained, plus buyUrl' },
  { route: '/api/v1/x402/loan-health', price: X402_PRICE, does: 'check_loan_health, for agents that already pay over x402' },
  { route: '/api/v1/x402/history', price: X402_PRICE_PREMIUM, does: '30 days of gap history plus the pool’s liquidity' },
  { route: '/api/v1/x402/lp-range', price: X402_PRICE_PREMIUM, does: 'A liquidity range sized from realized volatility' },
  { route: '/api/v1/x402/liquidation-capacity', price: X402_PRICE_PREMIUM, does: 'A stock’s borrow markets, the onchain-vs-oracle gap and the largest liquidation its pool can absorb' },
  { route: '/api/v1/x402/tape', price: X402_PRICE, does: 'get_tape, without an API key' },
  { route: '/api/v1/x402/quote', price: X402_PRICE, does: 'get_quote, without an API key' },
  { route: '/api/v1/x402/execute-link', price: X402_PRICE, does: 'A link to the stock’s own page on Afterbook with the buy amount filled in, priced live; the person signs' },
];

/** The free key for the plain JSON tape (app/api/v1/keys, app/api/v1/tape): POST once, then a Bearer header. */
export const FREE_KEY = {
  issue: 'POST https://afterbook.app/api/v1/keys',
  use: 'GET https://afterbook.app/api/v1/tape with Authorization: Bearer <key>',
  note: 'Free, no sign-up: the key is shown once (only its hash is stored) and lasts a year. Limits: 1 request a second per key, and 5 new keys a day per IP.',
};
