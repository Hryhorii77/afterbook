import { Redis } from '@upstash/redis';

// Shared by lib/history.ts and lib/alerts.ts. Works with either the legacy
// Vercel KV env var names (still what Vercel's own Upstash Marketplace
// integration provisions, for compatibility with the old @vercel/kv package)
// or Upstash's native names, so this doesn't care which one the store ends
// up configured as. `redis` is null (and every caller no-ops gracefully)
// when neither pair is set — local dev works fine without a store.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = KV_URL && KV_TOKEN ? new Redis({ url: KV_URL, token: KV_TOKEN }) : null;
