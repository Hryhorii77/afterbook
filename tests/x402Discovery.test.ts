import { describe, expect, it } from 'vitest';
import { bazaarResourceServerExtension, validateDiscoveryExtension } from '@x402/extensions/bazaar';
import { X402_DISCOVERY, bazaarListing, type X402Route } from '../lib/server/x402Discovery';

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
});
