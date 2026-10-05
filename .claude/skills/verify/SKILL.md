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
- All `lib/tokens.ts` pools share `tickSpacing: 10` (twelve tracked as of 2026-10-01).

## Testing the depth chart's drag interaction

The Lot Lab depth chart (`DepthChart.tsx`) is a draggable LP range
selector, not just a static SVG — two green handles, dragged with
`left_click_drag` via claude-in-chrome. It only renders once the LP tab
is active (see above) — click "LP" in the Lot Lab tab bar before
`find`-ing it. **Dragging is off by default** — click the "Adjust range"
toggle next to the "Liquidity depth" heading first (`dragEnabled` starts
`false` so a finger landing on the chart on mobile scrolls the page
instead of hijacking it as a drag); the range stays visible either way,
but `left_click_drag` on the handles is a no-op until that toggle is on.
Gotcha: the *first*
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

## Driving the newer UI headlessly (real viewports, themes, touch)

The claude-in-chrome window can't be resized below a desktop width, and
`chrome --headless --window-size=390,…` is NOT a phone: new headless
enforces a ~500px minimum, so layout happens wider and the screenshot is
cropped. For real viewport, theme and touch checks drive Chrome over the
DevTools protocol with `puppeteer-core` (install it in the scratchpad
directory, not the repo):

```js
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
const p = await b.newPage();
await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });   // a real phone viewport
await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);  // theme with no saved choice
await p.setExtraHTTPHeaders({ 'x-vercel-ip-country': 'DE' });                      // pass the fail-closed geo gate
await p.goto('http://localhost:3000/baskets', { waitUntil: 'networkidle2' });
```

- Run against a **production build** (`npm run build && npx next start
  -p <port>`), not `next dev` (see the wallet-modal CPU gotcha below).
  Run it with `.env.local` loaded if the page needs Redis/Glider
  (`set -a; . ./.env.local; set +a`).
- **Overflow check**: `document.documentElement.scrollWidth > innerWidth`
  at 390px, per page and per theme.
- **Themes**: the saved choice is `localStorage['afterbook-theme']`
  (`'light' | 'dark'`); with none saved the OS setting
  (`prefers-color-scheme`) decides. Each port/origin has its own storage.
- **Touch vs mouse**: `isMobile + hasTouch` gives `(hover: none)`, which
  is what the ticker pause rule keys off; a plain desktop page has a
  mouse (`hover: hover`).
- **Marquee**: read `new DOMMatrix(getComputedStyle(el).transform).m41`
  twice a second apart; unchanged means paused. It must move when idle,
  pause while a mouse hovers an item, and keep moving after a click and on
  touch.
- **Layout shift**: compare an element's *document* position
  (`getBoundingClientRect().top + scrollY`) before and after the thing
  that should not move the page. Let the page settle first (several
  seconds), or a chart still loading looks like a shift.
- **Screenshots of a scrolled page**: use an element screenshot or an
  unclipped viewport screenshot — `clip` coordinates are document-relative
  and silently capture the top of the page.
- **Lazy images**: full-page screenshots taken before scrolling show
  offscreen token icons as empty tiles (`loading="lazy"`); scroll through,
  then check `img.complete && img.naturalWidth > 0`.
- **Client-rendered pieces** (the ticker strip, trend charts, toasts) are
  absent from the server HTML by design — `curl` will not see them. Use a
  browser.
- **Notifications**: intercept `/api/tape` with `setRequestInterception`
  and return a scripted sequence (baseline → gap crosses 100 bp → market
  opens), and shorten the 60s poll by patching `window.setInterval`
  in `evaluateOnNewDocument`.

### What can't be driven headlessly

- **The RainbowKit wallet modal / a connected wallet.** A fake
  `window.ethereum` did not open the modal reliably. To look at
  wallet-dependent UI, render the presentational component with sample
  props in a **temporary** page (`MyLotsContent` takes plain props for
  exactly this); delete the page before committing and confirm the
  production build is clean without it. For the basket panel's connected
  states, ask the user to look with a real wallet.
- **Real-money actions** (enroll, deposit, publish a strategy version,
  withdraw): never from a script on your own initiative. See the
  `basis-tilt-ops` skill and `CLAUDE.md`.

## Baskets locally

- The enroll panel and `/api/baskets/*` only work when both
  `GLIDER_API_KEY` and `GLIDER_STRATEGY_ID` are set; otherwise they
  answer "not enabled yet". Locally `.env.local` may point
  `GLIDER_STRATEGY_ID` at a **test strategy** — check which one before
  trusting a "blocked: asset list does not match" from the basket job.
- `DEV_GEO_COUNTRY=DE` in `.env.local` lets `next dev` pass the
  fail-closed geo gate; a production build ignores it, so use the
  `x-vercel-ip-country` header there.
- Read-only checks are always safe: `curl` the `/api/baskets/portfolio`
  route, the `?dry=1` forms of `/api/cron/basket-tilt` and
  `/api/cron/discover-tokens` (with `Authorization: Bearer $CRON_SECRET`).

## Verifying the deployed site

After a merge, wait for the Vercel production deployment to be `Ready`
(`vercel ls`), then check the live site, not just the build: status
codes with `curl`, and a browser run (the `puppeteer-core` recipe works
against `https://afterbook.app` for read-only checks) for anything
rendered client-side.

## Local production build: region gate, wallet states, build gotchas

- **Region gate.** A local `next start` never receives Vercel's
  `x-vercel-ip-country` header, so the gate fails closed: Lot Lab's
  "Open on Aerodrome" / "Add liquidity" buttons and the Baskets panel are
  disabled ("Region could not be detected"). That is correct, not a bug.
  To click through the enabled state in your own browser without
  `next dev`, run a tiny header-adding proxy (local only):

  ```js
  // geoproxy.mjs: localhost:3001 -> localhost:3000 plus the Vercel header
  import http from 'node:http';
  http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: 3000, path: req.url, method: req.method,
      headers: { ...req.headers, host: 'localhost:3000', 'x-vercel-ip-country': 'DE' } },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end('upstream down'); });
    req.pipe(up);
  }).listen(3001, '127.0.0.1');
  ```
- **Wallet UI states** (connected, wrong network, switch failed): render
  `WalletButtonView` (props only) on a temporary page. Do **not** mount a
  second `WagmiProvider` with a mock connector inside the root layout: it
  looped ("Maximum update depth exceeded"; the cause was not found, and
  giving it its own `storage: null` did not help). Read URL state in a
  `useEffect`, not during render, or hydration mismatches. The layout's
  header has its own `.wallet-connect-btn`, so scope selectors to your
  test host (`#host .wallet-connect-btn`). Delete the temp page, then
  `rm -rf .next/dev` before the final build: a prior `next dev` run leaves
  generated types that still import the deleted page and fail the build
  with "Cannot find module '../../../app/tmp-…/page.js'".
- **See market-hours wording without waiting for the market.** Intercept
  `/api/tape` (puppeteer `setRequestInterception`), fetch the real tape from
  `127.0.0.1:3000`, then rewrite `session.state` (`'pre-market'`,
  `'after-hours'`, `'open'`) and each row's `cashPriceType`, `cashLastUsd`
  and `basisBp` (for a mixed tape give only some rows the extended-hours type: the table header should then read "Cash (latest)"); also patch `window.setInterval` in `evaluateOnNewDocument`
  so the 20s tape poll fires quickly, and wait with
  `waitUntil: 'domcontentloaded'` (a fast poll never lets the network go
  idle). Check the hero sentence and the cash-card label per state. Note:
  with no real extended-hours print (`cashPriceType === 'regular'`) the hero
  must say "Friday's close", never "pre-market price".
- **Share cards** are plain PNG routes: `curl -s localhost:3000/today/opengraph-image -o card.png` (also `/opengraph-image` and `/<SYMBOL>/opengraph-image`) and open the file. They render with satori, so a conditional wrapper must be a real flex `<div>` (a bare Fragment reorders children), and the content must fit in 1200x630 (check the bottom line is not crowded).
- **Gate commits on the build.** Chain `npm run build > log 2>&1 && git
  commit …`; with `;` a failed build still gets committed and a PR opened.
- **Quoting external links.** For a `t.me/<name>` link, `curl` the page
  and read `og:title`: "Contact @name" means no such user (a bot's real
  page shows its name). Confirm a bot's username with Telegram's `getMe`.
- Phone-width checks: price cards sit two per row under the hero and the
  hero's trade button should be on the first screen at 390px.

## Wallet-connect modal — dev-mode CPU gotcha

Both My Lots' own "Connect wallet" and the header's "Connect wallet"
button (`app/components/WalletConnectButton.tsx`) open the same
RainbowKit multi-wallet picker (`app/providers.tsx`, `lib/wagmiConfig.ts`)
instead of grabbing `window.ethereum` directly — they read the same
global wagmi account state, so testing either one is equivalent. Once
connected, clicking the button opens an account panel (it does not
disconnect); on a non-Base network it turns amber ("Wrong network").
**Under `npm run dev` specifically**, loading
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
