---
name: verify
description: Build/launch/drive recipe for verifying changes to the afterbook Next.js app at runtime.
---

# Verifying afterbook (Next.js app)

This is the root Next.js app (see project `CLAUDE.md` — do not confuse
with `contracts/jensen-buyback-burn/`, which is a separate Foundry
project with its own verify workflow).

## Launch

```bash
npm run dev            # next dev, port 3000
```

`.env.local` already has `KV_REST_API_URL`/`KV_REST_API_TOKEN` (real
Upstash Redis) so history/volatility/earnings data is live, not empty,
in local dev. Check with:

```bash
lsof -i :3000 -sTCP:LISTEN   # a next-server process may already be running
                              # from a prior session — reuse it, don't kill
                              # it blindly; curl :3000/ first to confirm it's healthy
```

## Drive it

- **API routes**: `curl -s -i "http://localhost:3000/api/<route>?..."`.
  For `/api/v1/x402/*` routes: without `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`/
  `X402_PAYOUT_ADDRESS` set, they correctly 503 with
  `{"error":"x402 tier not configured"}` — that IS the expected local
  response, not a failure. To exercise the actual handler logic
  (not just the paywall gate), call the underlying `lib/*` functions
  directly via a standalone script — see below.
- **UI**: claude-in-chrome tools. Homepage renders instantly with real
  on-chain tape data. Lot Lab / depth chart / impact curve are client-
  fetched (`useEffect`), so `curl` on `/` won't show them — screenshot
  the actual browser after `find`-ing the section heading and
  `scroll_to`.

## Bypassing the x402 paywall to test handler logic

The `handler()` function inside each `app/api/v1/x402/*/route.ts` is
plain async, independent of the `withX402` wrap. To sanity-check the
underlying math/data (not the payment gate) without touching CDP keys,
write a standalone script that imports the same `lib/*` functions the
handler calls, using **absolute file paths** as import specifiers
(Node ESM supports this) so it doesn't need tsconfig path aliases:

```ts
import { getStock } from '/Users/hryhorii/workSpace/afterbook/lib/tokens';
// ...
```

Run with real env loaded (Redis-backed functions need it):

```bash
node --env-file=.env.local $(which npx) tsx /path/to/script.ts
```

This hits the real Base RPC and real Redis — it's still a runtime
check, just below the HTTP layer, which is the only way to exercise
x402-gated logic without configuring payment locally.

## Known-good sanity checks

- `getCachedPoolState` + `getLiquidityDistribution` (lib/depth.ts): the
  bucket containing `currentTick` must carry liquidity exactly equal to
  `state.liquidity` — this is a hard invariant, not an approximation.
- `tickForPriceUsd` (lib/quote.ts) round-trips `midPriceUsd` to within
  one `tickSpacing` of the pool's actual current tick.
- All ten `lib/tokens.ts` pools share `tickSpacing: 10`.

## Cache-aware timing

`/api/depth` and `/api/v1/x402/history` both call
`getCachedLiquidityDistribution` (lib/depth.ts), which holds a 60s
in-memory cache per symbol — a repeat call to the same symbol inside
that window returns near-instantly and is NOT exercising a fresh
tick-bitmap/`ticks()` scan. To time or test the real cold-path RPC
work, either use a symbol not hit in the last 60s or wait out the TTL.
On local dev (single persistent process) this cache is reliable; on
Vercel it's per-warm-instance, so production timings are noisier and
don't cleanly separate into "cold" vs "cached" the way local ones do.
