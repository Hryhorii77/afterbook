# Afterbook

Cash close vs the Aero book, in shares. No wallet connect — execution stays on [Aerodrome](https://aerodrome.finance).

## What it shows

- **Tape**: cash-market last price vs Aerodrome's on-chain mid price for ten Coinbase tokenized stocks (NVDAc, AAPLc, METAc, GOOGLc, AMZNc, MSFTc, MSTRc, SNDKc, SPCXc, TSLAc), basis in bp, plus real pool depth.
- **Liquid vs thin split**: pools with real depth (≥ $100k, currently NVDAc/AAPLc/METAc/GOOGLc/AMZNc) lead the tape; everything thinner collapses behind a "Show N thin books" toggle at reduced size. A $10k pool's basis swings hundreds of bp on noise alone — giving it the same visual weight as a $2M pool made the tape read as broken. The split is driven by live depth, not a hardcoded symbol list, so a thin pool graduates automatically once it actually has liquidity.
- **Gap hero**: when the cash market isn't open, the page leads with "Cash market closed Xh Ym ago — Aerodrome has kept trading the whole time," each liquid symbol's move since that exact close, and when it reopens (holiday- and weekend-aware).
- **NY session clock**: cash-open / pre-market / after-hours / weekend / holiday state, so the 24/7-onchain-vs-24/5-cash gap is explicit, not implied.
- **Lot Lab**: type a USDC amount, see shares out, execution price, and a price-impact curve across a log-spaced range of trade sizes ($500–$1M) — computed from the pool's live `slot0()`/`liquidity()`, not a cached reserve snapshot. Also shows the same amount priced as a full-range LP position (≈50/50 by value — exact for full-range concentrated liquidity, with a caveat that Aerodrome defaults new deposits to a narrower range).
- **Execute**: deep links to Aerodrome's own swap and add-liquidity UIs, gated behind a non-US geo check and an eligibility checkbox. No wallet ever connects to this app.
- **Share card**: the OG/Twitter preview image is generated live from the same tape data, showing the biggest movers among the liquid names.
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
- No wallet connect, no seed phrase, no token approval, no custom swap router — this app never constructs calldata.
- The non-US geofence (`x-vercel-ip-country`) is a best-effort UX gate, not a compliance control — it's defeated by any VPN, and the UI says so. Detected-US viewers see explicit "not available" copy rather than a silently-disabled button.
- Every execution link points at `aerodrome.finance` — Aerodrome's own app decides how to route the trade.
- Strict CSP (script-src limited to same-origin + a fresh per-request nonce), HSTS, X-Frame-Options: DENY, no third-party scripts or fonts anywhere in the app.
- No environment variables, no API keys, nothing to leak — verified via a full git-history secret scan and GitHub's native secret scanning (both clean) plus a dependency vulnerability sweep of all resolved packages (zero findings).

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

No environment variables, no API keys.

## Deploying

```bash
npx vercel
```

or import the repo in the Vercel dashboard. No env vars needed.

## License

MIT.
