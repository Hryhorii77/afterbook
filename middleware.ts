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

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
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
