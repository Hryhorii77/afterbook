/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16's AGENTS.md/CLAUDE.md auto-generation (next dev) isn't a
  // convention this repo otherwise uses — off, rather than letting it
  // nag as an uncommitted diff on every future dev-server start.
  agentRules: false,
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
