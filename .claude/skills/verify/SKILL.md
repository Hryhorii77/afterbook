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
in local dev. **This is the same Redis instance production uses** —
confirmed directly (wrote real data locally, it was immediately
readable from `afterbook.app` with no separate deploy or sync step).
Cuts both ways: a one-time backfill/seed script run locally reaches
production instantly, which is genuinely useful — but so does any
throwaway write made "just to check something," so don't `recordX`/
`zadd`-style write against real keys from a scratch script unless you
mean for production to see it too. Reads are always safe. Check the
server's up with:

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
- **Lot Lab is tabbed** (Trade / LP / Carry — `HomeClient.tsx`'s
  `lotLabTab` state, defaults to Trade). Each tab's content is
  conditionally rendered (`{lotLabTab === 'lp' && (...)}`), not just
  CSS-hidden — a tool not currently on that tab is absent from the DOM,
  so `find`/`scroll_to` won't locate it. Click the tab button first:
  impact curve lives under Trade (default, no click needed), the
  depth-chart drag selector and fee-APR/in-range-odds metrics under LP,
  the cash-and-carry calculator under Carry (only renders real numbers
  when `arbEdge` is non-null — i.e. cash market closed with a basis
  edge; otherwise it's just the "no edge right now" note).

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

## Testing the depth chart's drag interaction

The Lot Lab depth chart (`DepthChart.tsx`) is a draggable LP range
selector, not just a static SVG — two green handles, dragged with
`left_click_drag` via claude-in-chrome. It only renders once the LP tab
is active (see above) — click "LP" in the Lot Lab tab bar before
`find`-ing it. Gotcha: the *first*
`left_click_drag` right after a page navigation reliably does nothing
(no visible change, no metric update) — this reproduces 100% of the
time and is a browser-automation timing artifact (page/hydration not
fully settled at the exact synthetic-event moment), not an app bug —
a real user's mouse won't hit this pattern. Every drag after the first
one works reliably. So: navigate, `find` + `scroll_to` the section,
do one throwaway drag (ignore whether it visibly worked), then do the
real test drag and screenshot that one.

Handles clamp to each other (min ~0.1% gap) and to `currentPriceUsd` —
dragging past the current-price line should make the handle stick
there, not cross over. If a metrics cell goes blank (`—`) after a
drag, check whether the range still brackets current price before
assuming a bug — `capitalEfficiencyMultiplier`/
`computeInRangeProbabilityPct` intentionally return `null` otherwise.

## My Lots' wallet-connect modal — dev-mode CPU gotcha

My Lots' "Connect wallet" now opens a RainbowKit multi-wallet picker
(`app/providers.tsx`, `lib/wagmiConfig.ts`) instead of grabbing
`window.ethereum` directly. **Under `npm run dev` specifically**, loading
the page has been observed to spin up a Chrome renderer process that
climbs to 60%+ CPU and keeps climbing — confirmed via `ps aux` showing
one PID monotonically increasing over ~30s, and confirmed it does NOT
stop on its own even after the tab is closed (only `kill -9`ing the
renderer PID stops it). Root-caused to React 19's dev-only strict-mode
double-invocation interacting with wagmi/RainbowKit's connector setup —
confirmed by testing the identical code as a production build
(`npm run build && npm run start`) under repeated, sustained `ps aux`
monitoring (20s+, including opening the connect modal) with zero runaway
CPU. So this is a `next dev`-only artifact, not a bug that reaches
production/Vercel (React never double-invokes in production regardless
of `reactStrictMode`) — but it's a real hazard while developing locally:
if a Chrome tab feels stuck after touching My Lots in dev, check
`ps aux | grep -i "chrome.*renderer"` for a PID climbing over time and
`kill -9` it rather than waiting it out or repeatedly reloading (reloading
without killing the old renderer compounds the problem — each stuck tab
keeps consuming CPU even after "closing" it in the UI). Prefer verifying
wallet-connect changes specifically against `npm run build && npm run
start` rather than `npm run dev` for this reason.

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
