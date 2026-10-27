import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the money paths (tests/*.test.ts). Offline by design: KyberSwap, the chain and Redis are
// mocked, so CI never touches production Redis (shared with local dev) or spends RPC calls.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
