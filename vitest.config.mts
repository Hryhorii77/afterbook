import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the money paths (tests/*.test.ts). Offline by design: KyberSwap, the chain and Redis are
// mocked, so CI never touches production Redis (shared with local dev) or spends RPC calls.
export default defineConfig({
  // 'server-only' throws outside Next's server build; in the tests every module runs on the server anyway.
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)), 'server-only': fileURLToPath(new URL('./tests/serverOnlyShim.ts', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
