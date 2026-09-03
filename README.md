# Afterbook

Cash close vs the Aero book, in shares. No wallet connect — execution stays on [Aerodrome](https://aerodrome.finance).

## What it shows

- **Tape**: cash-market last price vs Aerodrome's on-chain mid price for four Coinbase tokenized stocks (NVDAc, AAPLc, METAc, GOOGLc), basis in bp.
- **NY session clock**: cash-open / pre-market / after-hours / weekend / holiday state, so the 24/7-onchain-vs-24/5-cash gap is explicit, not implied.
- **Lot Lab**: type a USDC amount, see estimated shares out, execution price, and impact in bp — computed from the pool's live `slot0()`/`liquidity()`, not a cached reserve snapshot.
- **Execute**: a deep link to Aerodrome's own swap UI, gated behind a non-US geo check and an eligibility checkbox. No wallet ever connects to this app.

## Why the math is done the way it is

The four stock/USDC pools are Aerodrome **Slipstream** (concentrated-liquidity, Uniswap-V3-style) pools, not classic constant-product pools — confirmed on-chain (`stable()`/`getReserves()` revert, `slot0()`/`liquidity()`/`tickSpacing()` work). Aerodrome's documented public Quoter and SwapRouter are bound to a *different* CL factory than the one these pools were deployed through (`pool.factory() != quoter.factory()`, verified on-chain), so the standard Quoter reverts on these pools and can't be used here.

Instead, `lib/quote.ts` reads `slot0()` and `liquidity()` directly and uses the fact that a CL pool behaves exactly like a constant-product pool with virtual reserves `(L / sqrtP, L * sqrtP)` as long as a trade stays within the current tick's liquidity — that's exact math, not an approximation, but it stops being exact once a trade is large enough to cross into a different tick range (flagged as `largeTradeCaveat`). This is explicitly framed in the UI as an estimate for sizing a trade, not a firm quote — the actual fill always happens on Aerodrome's own app.

All four token and pool addresses in `lib/tokens.ts` were verified on-chain (`decimals()`, `token0()`/`token1()`, `fee()`) and cross-checked against Dexscreener's Aerodrome pair listings.

Each stock token also implements the [B20 asset standard](https://docs.base.org/get-started/issue-rwa)'s `multiplier()` — a fixed-point scalar the issuer can change to reflect a stock split without migrating raw balances. All four read 1.0x today, but `lib/quote.ts` reads it live on every quote rather than assuming 1.0 forever, so "shares out" stays correct if an issuer ever adjusts it.

On-chain reads go through `https://mainnet.base.org`, Base's documented official RPC endpoint, with a public third-party RPC as a fallback.

## Security model

- Allowlisted contracts only — four token addresses, four pool addresses, all verified on-chain.
- All price/quote fetches happen server-side (Next.js route handlers); the browser only talks to this app's own `/api/*` routes.
- No wallet connect, no seed phrase, no token approval, no custom swap router — this app never constructs calldata.
- The non-US geofence (`x-vercel-ip-country`) is a best-effort UX gate, not a compliance control — it's defeated by any VPN, and the UI says so.
- Every execution link points at `aerodrome.finance` — Aerodrome's own app decides how to route the trade.

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
