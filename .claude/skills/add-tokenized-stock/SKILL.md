---
name: add-tokenized-stock
description: Verify and add a new Coinbase tokenized-stock symbol (B20 token + Aerodrome Slipstream USDC pool) to lib/tokens.ts. Use when the discover-tokens cron has flagged a new candidate via Telegram, or the user asks to add a new stock symbol to Afterbook. Base has expanded this list before (4 -> 10 stocks) and will again.
---

# Add a new tokenized stock

`lib/tokens.ts`'s `STOCKS` array is the **single source of truth** — the
tape, Lot Lab, My Lots, the earnings/fee-snapshot crons, and the MCP
route all derive from it. Nothing else needs separate registration. The
liquid-vs-thin split is automatic (driven by live depth), not a
hardcoded list — a new addition doesn't need to be sorted into the right
bucket by hand.

## 1. Get on-chain verification

If this came from the `discover-tokens` cron's Telegram notification, it
already ran `verifyCandidate()` (`lib/discovery.ts`) and produced a
ready-to-paste snippet with `decimals`, `pool.address`, `pool.token0`,
`pool.feePpm` filled in, and a `multiplier() present/MISSING` note. Use
that as the starting point rather than re-deriving it — but still
complete the manual steps below, since the snippet deliberately leaves
`cashTicker`/`name` blank and doesn't cross-check Dexscreener.

If verifying from scratch (no cron snippet), run the same checks
`verifyCandidate` does, directly:

```bash
cast call <tokenAddress> "decimals()(uint8)" --rpc-url base
cast call <CL_FACTORY> "getPool(address,address,int24)(address)" <tokenAddress> <USDC> 10 --rpc-url base
cast call <poolAddress> "token0()(address)" --rpc-url base
cast call <poolAddress> "fee()(uint24)" --rpc-url base
cast call <tokenAddress> "multiplier()(uint256)" --rpc-url base   # confirm it exists; note if missing
```

(`CL_FACTORY` and `USDC` addresses are the constants already at the top
of `lib/tokens.ts`. Tick spacing has been `10` for every stock so far —
confirm it still is rather than assuming.)

## 2. Manual checks the automation doesn't do

- **Cross-check against Dexscreener's Aerodrome pair listing** for this
  token — the file's own header comment establishes this as the trust
  boundary precedent for every existing entry; don't add one without it.
- **`cashTicker` and `name`** — confirm against a real source (Yahoo
  Finance, the company's own ticker) rather than guessing from the
  on-chain symbol. The auto-generated snippet leaves these blank
  specifically because they're not derivable on-chain.
- **`multiplier()` presence** — if missing, that's a real anomaly worth
  flagging to the user before adding the entry, not silently working
  around.

## 3. Add the entry

Append a `CbStock` object to `STOCKS` in `lib/tokens.ts`, matching the
existing entries' field order and style exactly. Don't add a comment
explaining what the fields mean — the interface above them already
documents that.

## 4. Verify

- `npm run build` (typecheck).
- Load the app and confirm the new symbol appears in the tape with a
  real price and depth, not a NaN/error state.
- If it's thin (< `LIQUID_DEPTH_THRESHOLD_USD` in `lib/liquidity.ts`,
  currently $1M), confirm it correctly collapses behind the "Show N thin
  books" toggle rather than cluttering the main tape/hero.
