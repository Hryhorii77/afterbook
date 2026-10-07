---
name: add-tokenized-stock
description: Verify and add a new Coinbase tokenized-stock symbol (B20 token + Aerodrome Slipstream USDC pool) to lib/tokens.ts. Use when the discover-tokens cron sends a Telegram digest naming a candidate, or the user asks to add a new stock symbol to Afterbook. Coinbase lists far more tokens than Afterbook tracks (92 vs 12 on 2026-10-07; 58 on 2026-10-01); adding one never changes the Basis Tilt basket.
---

# Add a new tokenized stock

`lib/tokens.ts`'s `STOCKS` array is the **single source of truth** for
what the tape tracks — the tape, Lot Lab, My Lots, the ticker strip, the
trend charts, the earnings/fee-snapshot crons, and the MCP route all
derive from it (including the per-stock pages in `sitemap.xml`). Nothing else needs separate registration. The
liquid-vs-thin split is automatic (driven by live depth, not a hardcoded
list) — a new addition doesn't need to be sorted into a bucket by hand.
A pool under `LIQUID_DEPTH_THRESHOLD_USD` ($1M, `lib/liquidity.ts`) lands
in the "thin books" tier, which is correct for most new names.

**Adding a stock does NOT add it to the Basis Tilt basket.** The basket
universe is `BASKET_SYMBOLS` in `lib/baskets/tilt.ts`. Widening the
basket is a separate decision (new strategy version, wording to
Glider/users) — don't do it as part of this skill.

## 1. Find and rank candidates

*State on 2026-10-07:* of the 80 untracked tokens none had a liquid Aerodrome pool (best on Aerodrome ~$5k; best anywhere ~$25k on Uniswap), so nothing was added. Re-check only when the daily digest names a candidate.

Coinbase's own public list is the source of truth for *which tokens
exist*: `GET https://api.coinbase.com/v1/tokenized-stocks` (keyless; each
entry has `symbol`, `name`, `contract_address`, `decimals`, `icon_url`,
`multiplier`, `nav_price`). The older base.org/stocks page it replaced
listed only ten tokens and is stale — don't use it.

The daily `discover-tokens` cron (`app/api/cron/discover-tokens/route.ts`)
diffs that list against `STOCKS` and sends **one Telegram digest** of new
Aerodrome USDC pools with real depth, deepest first, plus a
ready-to-paste snippet for any pool over $250k. `?dry=1` (with the
`CRON_SECRET` bearer) returns the digest without sending or storing
anything — use it to see what it would report. A token is reported once
when it first has a pool and once more when that pool first becomes
liquid.

Most listed tokens have no pool or an empty one (~$0–1 depth), and a pool
can be initialised at a nonsense price that reads as astronomically deep
(`verifyCandidate` rejects those as "depth unreadable"). Don't add a name
on the strength of "it exists" — add it when depth is real.

## 2. Get on-chain verification

If the candidate came from the digest, its snippet already has
`decimals`, `pool.address`, `pool.token0`, `pool.feePpm`, `name` (from
Coinbase's list) and a `multiplier() present/MISSING` note. Use that as
the starting point, but still do the checks below.

From scratch (same checks `verifyCandidate` in `lib/discovery.ts` does):

```bash
cast call <tokenAddress> "decimals()(uint8)" --rpc-url base
cast call <CL_FACTORY> "getPool(address,address,int24)(address)" <tokenAddress> <USDC> 10 --rpc-url base
cast call <poolAddress> "token0()(address)" --rpc-url base
cast call <poolAddress> "fee()(uint24)" --rpc-url base
cast call <tokenAddress> "multiplier()(uint256)" --rpc-url base   # confirm it exists; note if missing
```

(`CL_FACTORY` and `USDC` are the constants at the top of `lib/tokens.ts`.
Tick spacing has been `10` for every stock so far — confirm it still is.
`cast` may not be installed; the same reads work with viem via
`getClient()` from `lib/quote.ts` in a `tsx` script.)

Measure real depth the way the app does: build a `CbStock`, then
`poolDepth(await readPoolState(stock), stock).totalUsd` (`lib/quote.ts`).
Don't trust Dexscreener's liquidity number alone.

## 3. Manual checks the automation doesn't do

- **Cross-check against Dexscreener's Aerodrome pair listing** for this
  token (`https://api.dexscreener.com/latest/dex/tokens/<address>`): the
  pair address must equal the pool you found. This is the repo's trust
  boundary precedent for every existing entry.
- **The contract address must match Coinbase's list** for that symbol —
  a vanity-looking `0xb200…` address is not proof (any B20 token,
  including memecoins, shares the prefix and identical on-chain code).
- **`cashTicker`** — the symbol minus the trailing `c` is usually right
  (`PLTRc` → `PLTR`); confirm against Yahoo Finance rather than assuming.
  `name` comes from Coinbase's list.
- **`multiplier()` presence** — if missing, flag it to the user before
  adding, don't silently work around it.
- **Checksummed addresses**: paste them as `getAddress()` returns them.

## 4. Add the entry

Append a `CbStock` object to `STOCKS` in `lib/tokens.ts`, matching the
existing entries' field order and style exactly. No explanatory comment —
the interface above documents the fields.

## 5. Update everything that counts or lists the stocks

```bash
grep -rnE "\bten\b|10 stocks" app lib README.md | grep -v "^app/baskets/risks"
```

- Wording that describes the **tracked list** must change (My Lots empty
  state, public API / MCP descriptions, README). Wording that describes
  the **basket** ("ten Base tokenized stocks" on `/baskets`) stays — the
  basket is still `BASKET_SYMBOLS`.
- Add the token + pool row to the README's contract address table, and
  note the verification date in "Why the math is done the way it is".
- The earnings/history/trend data for a new symbol starts empty and
  fills in as samples accumulate. Expect, for a brand-new token: a
  "New · Nd" pill instead of a trend chart until it has 3 days of
  samples; a 24h change measured over slightly under 24 hours (nearest
  sample within a 3-hour tolerance) or a dash if none; and no card in
  "who mean-reverts at the open" on `/today` until it has 8 usable
  trading sessions (`MIN_DAYS_FOR_OPEN_SNAP` in `lib/history.ts`), so
  roughly 1.5 to 2 calendar weeks. None of that is a bug.

## 6. Verify

- `npm run build` (typecheck).
- Run the production build (`npm run build && npx next start -p <port>`)
  and `curl /api/tape`: the new row must have a real price, a basis and
  a depth, not NaN/null.
- Look at it in a browser: it appears in the tape, the ticker strip, the
  stock chooser, and — if thin — behind "Show N thin books".
- `curl "/api/cron/basket-tilt?dry=1"` (with the cron bearer) against
  the **live** strategy id: it must still report the ten basket names
  and not be `blocked`. If it is blocked, the basket universe changed by
  accident.
