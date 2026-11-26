// Bazaar discovery for the paid x402 routes (2026-11-25, for agent traction): each route declares what it takes and
// an example of what it returns, so Coinbase's facilitator can catalog it in the x402 Bazaar, where agents search for
// services to pay (the method, GET, is filled in by the server extension). Listing metadata only: it changes no price, payee, check or answer. A route is catalogued once a
// payment for it is settled through the facilitator.
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';

const SERVICE = { serviceName: 'Afterbook', iconUrl: 'https://afterbook.app/icon1.png', mimeType: 'application/json' } as const;
const BASE_TAGS = ['tokenized-stocks', 'base', 'coinbase'];

const SYMBOL = { type: 'string', description: 'A tracked Coinbase tokenized stock, e.g. NVDAc, AAPLc' };
const WALLET = { type: 'string', description: 'A wallet address (0x followed by 40 hex characters)' };

interface RouteDiscovery {
  tags: string[];
  input: Record<string, unknown>;
  properties: Record<string, unknown>;
  required: string[];
  output: unknown;
}

function discoverable(d: RouteDiscovery) {
  return {
    ...SERVICE,
    tags: [...BASE_TAGS, ...d.tags],
    extensions: declareDiscoveryExtension({ input: d.input, inputSchema: { properties: d.properties, required: d.required }, output: { example: d.output } }),
  };
}

const LIMITS = {
  maxPremiumBp: { type: 'number', description: 'Most the token may trade above the real stock, in bp (default 50)' },
  maxCostBp: { type: 'number', description: 'Most a fill may cost, price impact plus pool fee, in bp (default 30)' },
  earningsDays: { type: 'integer', description: 'Wait if earnings are within this many days: 0, 2 or 7 (default 2)' },
};

/** Each paid route's listing, keyed by its path under /api/v1/x402/. */
export const X402_DISCOVERY = {
  plan: {
    tags: ['trading', 'agents', 'plan'],
    input: { symbols: 'NVDAc,AAPLc', budgetUsd: 100 },
    properties: { symbols: { type: 'string', description: 'Comma-separated tracked stocks; none = the deepest pools' }, budgetUsd: { type: 'number', description: 'USDC to plan for' }, ...LIMITS },
    required: ['budgetUsd'],
    output: { plan: { legs: [{ symbol: 'NVDAc', verdict: 'buy' as const, usd: 50, costBp: 3.4, gapBp: -2.2 }] }, explanation: '…', planUrl: 'https://afterbook.app/plan/AbCdEfGhIjKlMnOp' },
  },
  basket: {
    tags: ['trading', 'agents', 'basket'],
    input: { theme: 'AI', budgetUsd: 200 },
    properties: {
      theme: { type: 'string', description: 'One of Afterbook’s fixed themes (default Any)' },
      exclude: { type: 'string', description: 'Comma-separated GICS sectors to leave out' },
      minStocks: { type: 'integer' },
      budgetUsd: { type: 'number', description: 'USDC for the basket' },
      cashPct: { type: 'number' },
      ...LIMITS,
    },
    required: ['budgetUsd'],
    output: { brief: { basket: [{ symbol: 'NVDAc', weightPct: 50 }, { symbol: 'MSFTc', weightPct: 50 }] }, explanation: '…', buyUrl: 'https://afterbook.app/plan/AbCdEfGhIjKlMnOp' },
  },
  'loan-health': {
    tags: ['lending', 'aave', 'morpho', 'risk'],
    input: { wallet: '0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae' },
    properties: { wallet: WALLET, threshold: { type: 'number', description: 'Health to flag loans under (default 1.2)' } },
    required: ['wallet'],
    output: { loans: [{ venue: 'aave', healthFactor: 1.62, healthAtAero: 1.66, healthIfNextOpenAtBase: 1.66, belowThreshold: false, actions: { repayUrl: 'https://afterbook.app/borrow?rescue=repay&fall=0&target=1.3#borrow-here' } }] },
  },
  history: {
    tags: ['market-data', 'history'],
    input: { symbol: 'NVDAc' },
    properties: { symbol: SYMBOL, since: { type: 'integer', description: 'Start, in epoch milliseconds (default 30 days ago)' } },
    required: ['symbol'],
    output: { symbol: 'NVDAc', since: 1761400000000, basisHistory: [{ ts: 1764000000000, basisBp: 4.4 }], tickDistribution: { currentTick: 50210, currentPriceUsd: 153.4, buckets: [] } },
  },
  'lp-range': {
    tags: ['liquidity', 'lp', 'volatility'],
    input: { symbol: 'NVDAc', holdingDays: 7 },
    properties: { symbol: SYMBOL, holdingDays: { type: 'integer' }, targetProbabilityPct: { type: 'number' } },
    required: ['symbol'],
    output: { symbol: 'NVDAc', currentPriceUsd: 153.4, holdingDays: 7, targetProbabilityPct: 70, recommendedRange: { lowUsd: 141.2, highUsd: 166.1, tickLower: -1000, tickUpper: 1000 } },
  },
  'liquidation-capacity': {
    tags: ['lending', 'liquidation', 'risk'],
    input: { symbol: 'NVDAc' },
    properties: { symbol: SYMBOL, collateralShares: { type: 'number' }, borrowUsd: { type: 'number' }, marketId: { type: 'string' } },
    required: ['symbol'],
    output: { symbol: 'NVDAc', aeroMidUsd: 153.4, sellCurve: [{ usd: 10000, discountBp: 12 }], markets: [{ venue: 'aave', marketId: 'aave:3' }], position: null },
  },
  tape: {
    tags: ['market-data', 'prices'],
    input: {},
    properties: {},
    required: [],
    output: { session: { state: 'open', label: 'Cash market open', nyTime: '14:25' }, asOf: 1764012300000, rows: [{ symbol: 'NVDAc', cashUsd: 153.4, midUsd: 153.37, basisBp: -2.2, depthUsd: 1790160 }] },
  },
  quote: {
    tags: ['market-data', 'quote'],
    input: { symbol: 'NVDAc', usdcIn: 1000 },
    properties: { symbol: SYMBOL, usdcIn: { type: 'number', description: 'USDC to spend' } },
    required: ['symbol', 'usdcIn'],
    output: { symbol: 'NVDAc', usdcIn: 1000, sharesOut: 6.51, midPriceUsd: 153.4, execPriceUsd: 153.6, impactBp: 1.2, feeBp: 5, largeTradeCaveat: false, curve: [] },
  },
  'execute-link': {
    tags: ['trading', 'links'],
    input: { symbol: 'NVDAc', usdcIn: 100 },
    // usdcIn is required: the route refuses a request without it (review, 2026-11-25).
    properties: { symbol: SYMBOL, usdcIn: { type: 'number', exclusiveMinimum: 0, maximum: 10_000_000 }, direction: { type: 'string', enum: ['buy', 'sell'] } },
    required: ['symbol', 'usdcIn'],
    output: { symbol: 'NVDAc', direction: 'buy', usdcIn: 100, sharesOut: 0.65, execPriceUsd: 153.5, impactBp: 0.4, largeTradeCaveat: false, swapUrl: 'https://afterbook.app/NVDAc?side=buy&usdc=100#execute' },
  },
} satisfies Record<string, RouteDiscovery>;

export type X402Route = keyof typeof X402_DISCOVERY;

/** The route config fields that list `route` in the x402 Bazaar: spread into withX402's config. */
export const bazaarListing = (route: X402Route) => discoverable(X402_DISCOVERY[route]);

/** The path each paid route is served at. */
export const x402Path = (route: X402Route) => `/api/v1/x402/${route}`;

/** withX402's routes argument in the keyed form: the route's own fixed path, so the Bazaar lists that path rather
 *  than a wildcard. The key MUST match the request path: x402 answers "no payment required" for a path no key
 *  matches, so a wrong key would make the route free (tests/x402Discovery.test.ts checks every route). */
export function x402Route<C extends object>(route: X402Route, config: C): Record<string, C> {
  return { [x402Path(route)]: config };
}
