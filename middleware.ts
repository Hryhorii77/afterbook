import { NextRequest, NextResponse } from 'next/server';

// Next.js App Router ships several inline <script> tags of its own (the RSC
// hydration payload) on every page. A static `script-src 'self'` with no
// allowance for those blocks them silently — no catchable JS error, just a
// CSP violation — which makes React's hydration throw and unmount the whole
// tree, leaving a blank page. (Found this the hard way: the deployed site
// rendered a solid black screen because of exactly this.)
//
// The fix is Next's documented pattern: generate a fresh nonce per request,
// put it in the CSP `script-src`, and Next automatically stamps that same
// nonce onto the inline scripts it renders — so only Next's own hydration
// scripts execute, nothing else.
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  // Next's dev-mode React Fast Refresh runtime evaluates code via eval() for
  // hot-module-reloading — a production-equivalent CSP with no 'unsafe-eval'
  // blocks that outright, silently breaking all client interactivity in
  // `next dev` (hydration errors with no useful message). Production builds
  // don't use eval-based HMR at all, so this only loosens the dev server.
  const scriptSrc =
    process.env.NODE_ENV === 'development'
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  // The wallet-connect modal (RainbowKit/wagmi, lib/wagmiConfig.ts) needs
  // its own carve-outs on top of the policy above:
  //  - connect-src: WalletConnect/Reown's relay (wss, for the actual
  //    session) and their API (wallet metadata/icons, fetched over https).
  //    A blocked relay socket isn't a silent no-op — WalletConnect's SDK
  //    retries aggressively, which under connect-src 'self' alone showed up
  //    as the tab never reaching document_idle (looked like a hang, not an
  //    error) rather than a clean CSP-violation message.
  //  - img-src: same Reown domains, for wallet icons the modal fetches
  //    remotely instead of bundling.
  //  - frame-src: Coinbase Wallet's SDK popup communication happens through
  //    an iframe on Coinbase's own domain, not window.open.
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://explorer-api.walletconnect.com https://api.web3modal.org",
    "connect-src 'self' https://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.com wss://*.walletconnect.org https://*.reown.com https://api.web3modal.org https://pulse.walletconnect.org https://mainnet.base.org https://base-rpc.publicnode.com",
    "frame-src https://*.coinbase.com https://keys.coinbase.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // run on everything except static assets, so pages and route handlers
    // all get the CSP header, without wasting a middleware pass on assets
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
