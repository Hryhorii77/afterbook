import { describe, expect, it } from 'vitest';
import { bazaarResourceServerExtension, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { existsSync, readFileSync } from 'node:fs';
import { x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import { X402_DISCOVERY, bazaarListing, x402Path, x402Route, type X402Route } from '../lib/server/x402Discovery';
import type { HistorySample } from '../lib/market/history';
import type { LiquidityDistribution } from '../lib/market/depth';
import type { BasketLeg } from '../lib/build/customBasket';
import type { PublicTape } from '../lib/market/publicTape';
import type { Plan } from '../lib/agent/plan';
import type { LotEstimate } from '../lib/market/quote';

// Compile-time: each example is a partial of the route's real answer, so a renamed or reshaped field fails the
// typecheck (npm run typecheck covers tests/). Routes without an exported answer type are checked below at runtime.
type DeepPartial<T> = T extends (infer U)[] ? DeepPartial<U>[] : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
X402_DISCOVERY.history.output satisfies DeepPartial<{ symbol: string; since: number; basisHistory: HistorySample[]; tickDistribution: LiquidityDistribution }>;
X402_DISCOVERY.basket.output satisfies DeepPartial<{ brief: { basket: BasketLeg[] }; explanation: string; buyUrl: string }>;
X402_DISCOVERY.tape.output satisfies DeepPartial<PublicTape>;
X402_DISCOVERY.plan.output satisfies DeepPartial<{ plan: Plan; explanation: string; planUrl: string }>;
X402_DISCOVERY.quote.output satisfies DeepPartial<LotEstimate & { symbol: string; curve: unknown[] }>;

// Bazaar listings for the nine paid routes (2026-11-25): each must pass the x402 library's own check, carry the
// service name, tags and icon, and require only parameters the route reads.
describe('x402 Bazaar listings', () => {
  const routes = Object.keys(X402_DISCOVERY) as X402Route[];
  it('covers all nine paid routes', () => {
    expect(routes.sort()).toEqual(['basket', 'execute-link', 'history', 'liquidation-capacity', 'loan-health', 'lp-range', 'plan', 'quote', 'tape']);
  });
  for (const route of routes) {
    it(`${route}: a valid discovery extension with Afterbook's service metadata`, () => {
      const listing = bazaarListing(route);
      expect(listing.serviceName).toBe('Afterbook');
      expect(listing.iconUrl).toBe('https://afterbook.app/icon1.png');
      expect(listing.tags).toContain('tokenized-stocks');
      // As the server sends it: the registered bazaar extension adds the HTTP method from the request.
      const declared = Object.values(listing.extensions)[0];
      const ext = bazaarResourceServerExtension.enrichDeclaration!(declared, { method: 'GET', adapter: { getMethod: () => 'GET', getPath: () => `/api/v1/x402/${route}` } });
      const result = validateDiscoveryExtension(ext as Parameters<typeof validateDiscoveryExtension>[0]);
      expect(result.valid, JSON.stringify(result)).toBe(true);
      // Every required parameter is one the schema describes.
      const d = X402_DISCOVERY[route];
      for (const r of d.required) expect(Object.keys(d.properties)).toContain(r);
    });
  }

  it('execute-link lists usdcIn as required, as the route refuses a request without it (review, 2026-11-25)', () => {
    expect(X402_DISCOVERY['execute-link'].required).toEqual(['symbol', 'usdcIn']);
    expect(X402_DISCOVERY['execute-link'].input).toHaveProperty('usdcIn');
  });

  it('the examples use the real field names (runtime check of the shapes fixed in review)', () => {
    const h = X402_DISCOVERY.history.output;
    expect(Object.keys(h.basisHistory[0]).sort()).toEqual(['basisBp', 'ts']);
    expect(Object.keys(h.tickDistribution).sort()).toEqual(['buckets', 'currentPriceUsd', 'currentTick']);
    expect(Object.keys(X402_DISCOVERY.basket.output.brief.basket[0]).sort()).toEqual(['symbol', 'weightPct']);
  });
});

// The keyed routes form: a key that doesn't match the request path makes x402 answer "no payment required", so
// every route's key is checked against its real path with the library's own matcher.
describe('x402 route keys', () => {
  const routes = Object.keys(X402_DISCOVERY) as X402Route[];
  const http = (route: X402Route) =>
    new x402HTTPResourceServer(
      new x402ResourceServer({} as never),
      x402Route(route, { accepts: { scheme: 'exact', price: '$0.02', network: 'eip155:8453', payTo: '0x0000000000000000000000000000000000000001' } }) as never,
    );
  for (const route of routes) {
    it(`${route}: the key is the route's own folder and matches its requests`, () => {
      expect(existsSync(`app${x402Path(route)}/route.ts`)).toBe(true);
      // The route file passes its own folder name, to both the path key and the listing (a copied route
      // that still said another name would put the wrong path or listing on it).
      const source = readFileSync(`app${x402Path(route)}/route.ts`, 'utf8');
      expect(source).toContain(`x402Route('${route}',`);
      expect(source).toContain(`bazaarListing('${route}')`);
      expect(source.match(/x402Route\('/g)).toHaveLength(1);
      expect(source.match(/bazaarListing\('/g)).toHaveLength(1);
      const server = http(route);
      const paid = (path: string, method = 'GET') => server.requiresPayment({ path, method, adapter: { getMethod: () => method, getPath: () => path } } as never);
      for (const path of [x402Path(route), `${x402Path(route)}/`, `${x402Path(route)}?symbol=NVDAc&budgetUsd=100`, x402Path(route).toUpperCase()]) {
        expect(paid(path), path).toBe(true);
      }
      expect(paid(x402Path(route), 'HEAD')).toBe(true);
      // Not another route's path.
      const other = routes.find((r) => r !== route)!;
      expect(paid(x402Path(other))).toBe(false);
    });
  }
});
