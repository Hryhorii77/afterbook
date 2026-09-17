# Afterbook

**Live at [afterbook.app](https://afterbook.app).**

Cash close vs the Aero book, in shares. No wallet ever signs anything — execution stays on [Aerodrome](https://aerodrome.finance).

## What it shows

- **Tape**: cash-market last price vs Aerodrome's on-chain mid price for ten Coinbase tokenized stocks (NVDAc, AAPLc, METAc, GOOGLc, AMZNc, MSFTc, MSTRc, SNDKc, SPCXc, TSLAc), basis in bp, plus real pool depth.
- **Liquid vs thin split**: pools with real depth (≥ $100k, currently NVDAc/AAPLc/METAc/GOOGLc/AMZNc) lead the tape; everything thinner collapses behind a "Show N thin books" toggle at reduced size. A $10k pool's basis swings hundreds of bp on noise alone — giving it the same visual weight as a $2M pool made the tape read as broken. The split is driven by live depth, not a hardcoded symbol list, so a thin pool graduates automatically once it actually has liquidity.
- **Gap hero**: when the cash market isn't open, the page leads with "Cash market closed Xh Ym ago — Aerodrome has kept trading the whole time," each liquid symbol's move since that exact close, and when it reopens (holiday- and weekend-aware).
- **Basis since close**: a sparkline of the selected symbol's basis from the last cash close to now, sampled opportunistically off real traffic into Redis (no cron job) — gaps fill in as the app keeps running, and it works with zero setup (just renders empty) if no Redis store is configured. The same 30-day retained history also powers a one-line stat underneath — mean/max basis while the cash market was closed — once there's enough sampled history.
- **NY session clock**: cash-open / pre-market / after-hours / weekend / holiday state, so the 24/7-onchain-vs-24/5-cash gap is explicit, not implied.
- **Lot Lab**: type a USDC amount (or pick a size preset — $250 / $1k / $5k / 1% of the pool), see shares out, execution price, and a price-impact curve across a log-spaced range of trade sizes ($500–$1M) — computed from the pool's live `slot0()`/`liquidity()`, not a cached reserve snapshot. Also shows the same amount priced as a full-range LP position (≈50/50 by value — exact for full-range concentrated liquidity, with a caveat that Aerodrome defaults new deposits to a narrower range). A "Copy trade" button copies the sized trade as plain text.
- **My Lots**: connect a wallet (read-only — the connection only reveals your public address, nothing is ever signed) to see spot share balances and Aerodrome LP positions across the ten stocks, priced live. Shows your [Basename](https://www.base.org/names) instead of the raw address when one's set, resolved directly against Base's own L2Resolver — no separate mainnet RPC, no extra dependency. LP position data comes from Aerodrome/Velodrome's own "Sugar" read-helper contract (`positionsByFactory`), not the publicly-documented NFT position manager — that one is bound to a different CL factory than these specific pools use and would silently show nothing. Each LP position also shows its price range with in-range/out-of-range status, fees and AERO emissions earned, and lock expiry if locked — all fields Sugar already returns on the same call, just surfaced rather than discarded.
- **Execute**: deep links to Aerodrome's own swap and add-liquidity UIs, gated behind a non-US geo check and an eligibility checkbox. No wallet ever signs a transaction through this app.
- **Log**: a session-local, timestamped feed of notable events (starting with "cash just closed" plus each liquid symbol's basis at that instant).
- **Telegram alerts**: `/alert SYMBOL BP` pings when a symbol's |basis| crosses a threshold; `/close` pings once with every liquid name's basis the moment the cash market closes. A Vercel Cron job re-evaluates every 5 minutes against live tape data and fires only on the transition, not every tick a condition holds.
- **Public API**: a versioned, documented `/api/v1/tape` for external consumers, separate from the unauthenticated `/api/tape` the site itself polls — see "Public API" below.
- **Share card**: the OG/Twitter preview image is generated live from the same tape data, showing the biggest movers among the liquid names.
- **Base Mini App**: registered on [base.dev](https://base.dev), verified via the `base:app_id` meta tag in `app/layout.tsx`. Base split from the Farcaster Mini App spec in April 2026 — registered apps are treated as standard web apps now, so there's no manifest file or SDK call here, just the base.dev listing itself.
- Dark-only by design — `color-scheme: dark` forces native form controls and mobile browser chrome to render correctly even when the viewer's device is in light mode.

## Why the math is done the way it is

The stock/USDC pools are Aerodrome **Slipstream** (concentrated-liquidity, Uniswap-V3-style) pools, not classic constant-product pools — confirmed on-chain (`stable()`/`getReserves()` revert, `slot0()`/`liquidity()`/`tickSpacing()` work). Aerodrome's documented public Quoter and SwapRouter are bound to a *different* CL factory than the one these pools were deployed through (`pool.factory() != quoter.factory()`, verified on-chain), so the standard Quoter reverts on these pools and can't be used here.

Instead, `lib/quote.ts` reads `slot0()` and `liquidity()` directly and uses the fact that a CL pool behaves exactly like a constant-product pool with virtual reserves `(L / sqrtP, L * sqrtP)` as long as a trade stays within the current tick's liquidity — that's exact math, not an approximation, but it stops being exact once a trade is large enough to cross into a different tick range (flagged as `largeTradeCaveat`, and shaded on the impact curve). This is explicitly framed in the UI as an estimate for sizing a trade, not a firm quote — the actual fill always happens on Aerodrome's own app.

Pool depth (the tape's Depth column, and the liquid/thin split) comes from real `token.balanceOf(pool)` reads — deliberately *not* the virtual reserves used for impact math, which describe in-range liquidity depth and run much larger than what's actually deployed.

All token and pool addresses in `lib/tokens.ts` were verified on-chain (`decimals()`, `token0()`/`token1()`, `fee()`, `factory()`) and cross-checked against Dexscreener's Aerodrome pair listings — the original four on 2026-09-04, plus AMZNc/MSFTc/MSTRc/SNDKc/SPCXc/TSLAc on 2026-09-05 when Base expanded to ten tokenized stocks. All ten share the same CL factory, 0.05% fee tier, and tick spacing. Liquidity on the newer six is much thinner ($10k–$110k vs $1–2M on the original four) — that's why the tape splits them out, and why their impact curves and `largeTradeCaveat` trip at far smaller sizes.

Each stock token also implements the [B20 asset standard](https://docs.base.org/get-started/issue-rwa)'s `multiplier()` — a fixed-point scalar the issuer can change to reflect a stock split without migrating raw balances. All ten read 1.0x today, but `lib/quote.ts` reads it live on every quote rather than assuming 1.0 forever, so "shares out" stays correct if an issuer ever adjusts it.

On-chain reads go through `https://mainnet.base.org`, Base's documented official RPC endpoint, with a public third-party RPC as a fallback.

## Security model

- Allowlisted contracts only — ten token addresses, ten pool addresses, all verified on-chain.
- All price/quote fetches happen server-side (Next.js route handlers); the browser only talks to this app's own `/api/*` routes.
- My Lots connects a wallet to *read* balances — no seed phrase ever touches this app, no signature or approval is ever requested, no custom swap router, and this app never constructs calldata. Connecting only exposes the public address, which is already public on-chain regardless.
- The non-US geofence (`x-vercel-ip-country`) is a best-effort UX gate, not a compliance control — it's defeated by any VPN, and the UI says so. Detected-US viewers see explicit "not available" copy rather than a silently-disabled button.
- Every execution link points at `aerodrome.finance` — Aerodrome's own app decides how to route the trade.
- Strict CSP (script-src limited to same-origin + a fresh per-request nonce), HSTS, X-Frame-Options: DENY, no third-party scripts or fonts anywhere in the app.
- No user secrets anywhere — the only environment variables are a Redis (Upstash) REST URL/token for the basis-history sparkline, infra config rather than anything tied to a user or a wallet. No API keys otherwise. Verified via a full git-history secret scan and GitHub's native secret scanning (both clean) plus a dependency vulnerability sweep of all resolved packages (zero findings).

### Contract addresses

All on Base mainnet, verified on-chain (`decimals()`/`token0()`/`token1()`/`fee()`/`factory()`) against Dexscreener's Aerodrome pair listings — see `lib/tokens.ts` for the full verification note.

| Symbol | Token address | Pool address (USDC pair) |
| --- | --- | --- |
| NVDAc | `0xb20000000000000000000078ee7ce2fE4908108C` | `0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9` |
| AAPLc | `0xb200000000000000000000C2e324d24d7eEcd1fb` | `0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0` |
| METAc | `0xb2000000000000000000008bC8786B856E61707C` | `0xEAF57753BC382E0324a1D43F72E7027705a2273E` |
| GOOGLc | `0xb2000000000000000000002D0BA3164cc74f58B7` | `0xB1987CAD1682841b4b641d50E520777eC5Ab5542` |
| AMZNc | `0xb200000000000000000000d9192b6B456483C2E8` | `0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b` |
| MSFTc | `0xB200000000000000000000Ab99cFa739E253872B` | `0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54` |
| MSTRc | `0xb2000000000000000000004884b426556b92883d` | `0x8b27f626ab668197000BC722A1012022CAeD10E2` |
| SNDKc | `0xb200000000000000000000397293Cb8cda9a10c5` | `0x5A8236f575471e7BfCA2C8462a200c28f737246E` |
| SPCXc | `0xb2000000000000000000007b9fcbd005511aCBd5` | `0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E` |
| TSLAc | `0xb2000000000000000000001e800a7f5189430cD0` | `0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB` |

USDC on Base: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. CL factory (not Aerodrome's public Quoter/SwapRouter factory — see security model above): `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

No environment variables required to run it — the app works fully without them. Optionally:

- `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) — a Redis (Upstash) REST endpoint. Enables the "basis since close" sparkline's history, Telegram alerts, and the public API's key storage. Without it, the sparkline stays empty and both features return `503`.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` — enables Telegram alerts. The token comes from [@BotFather](https://t.me/BotFather); the webhook secret is any random string you generate yourself, passed to Telegram's `setWebhook` as `secret_token` and checked against the `X-Telegram-Bot-Api-Secret-Token` header on every incoming update.
- `CRON_SECRET` — a random string Vercel automatically attaches as `Authorization: Bearer <secret>` on cron-triggered requests ([documented pattern](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)); secures the cron routes against being triggered by anyone else.
- `TELEGRAM_ADMIN_CHAT_ID` — maintainer-only. A daily cron diffs [base.org/stocks](https://www.base.org/stocks) (Coinbase's own published list) against the tickers tracked in `lib/tokens.ts` and Telegram-pings this chat ID with a ready-to-paste entry when Coinbase adds a new tokenized stock. It never edits `lib/tokens.ts` itself — a human still reviews and adds each one, same as all ten current entries.

## Public API

`/api/v1/tape` is a separate, versioned, documented contract for external consumers (bots, agents) — distinct from the unauthenticated `/api/tape` the site's own frontend polls, so internal refactors never silently break external callers.

Get a key (free, instant, no signup):
```bash
curl -X POST https://afterbook.app/api/v1/keys
```

Call the tape with it:
```bash
curl https://afterbook.app/api/v1/tape -H "Authorization: Bearer ab_..."
```

Response shape (frozen — internal-only fields like `cashTicker`/`name`/`cashStale` are deliberately not part of this contract):
```json
{
  "session": { "state": "after-hours", "label": "After-hours", "nyTime": "16:30" },
  "asOf": 1735000000000,
  "rows": [
    { "symbol": "NVDAc", "cashUsd": 218.36, "midUsd": 218.65, "basisBp": 13.5, "depthUsd": 2500000 }
  ]
}
```

Rate limit: 1 request/second per key.

## Agent / MCP

`https://afterbook.app/api/mcp` is a remote [MCP](https://modelcontextprotocol.io) server for agents (Claude, etc.) — no key, no signup, read-only. Add it as a remote MCP server in Claude Code, Claude Desktop, or any MCP-compatible client pointed at that URL.

Three tools:

- **`get_tape`** — no input. Same data as `/api/v1/tape` above.
- **`get_quote`** — `{ symbol, usdcIn }`. Shares out, execution price, and price impact for sizing a USDC → stock trade — the same estimate Lot Lab shows, not a firm quote; the actual fill always happens on Aerodrome's own app.
- **`get_basis_stats`** — `{ symbol }`. Mean/mean-absolute/max-absolute basis in bp while the cash market was closed, over the last 30 days of sampled history. `null` if there isn't enough history yet.

## Deploying

```bash
npx vercel
```

or import the repo in the Vercel dashboard. No env vars required — add the Redis ones from "Running it" above (e.g. via a Vercel-connected Upstash integration) if you want the sparkline to accumulate history in production.

## License

MIT.
