/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16's AGENTS.md/CLAUDE.md auto-generation (next dev) isn't a
  // convention this repo otherwise uses — off, rather than letting it
  // nag as an uncommitted diff on every future dev-server start.
  agentRules: false,
  // @rainbow-me/rainbowkit's bundled dist/index.js statically imports every
  // wallet connector it ships, including one backed by wagmi/connectors'
  // baseAccount -> @base-org/account -> @coinbase/cdp-sdk, whose Solana
  // code path does a dynamic import of @x402/svm/exact/client — a package
  // this app doesn't have (Afterbook is EVM/Base-only, and already has its
  // own unrelated @x402/* deps for the x402 payment routes). That's true
  // regardless of which wallets are actually configured (see
  // lib/wagmiConfig.ts) — RainbowKit's own module graph pulls it in just
  // from importing getDefaultConfig. Turbopack's SSR bundler tries to
  // statically resolve that dynamic import at build time and fails outright
  // since the package isn't installed. Marking cdp-sdk (and its own parent)
  // external stops Turbopack from bundling into it at all — the unresolved
  // import becomes a plain runtime one inside a code path this app never
  // actually calls (no Solana / CDP usage anywhere here).
  serverExternalPackages: ['@coinbase/cdp-sdk', '@base-org/account'],
  // Content-Security-Policy is set in middleware.ts instead of here, because
  // it needs a fresh nonce per request to allow Next's own inline hydration
  // scripts while still blocking everything else.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
