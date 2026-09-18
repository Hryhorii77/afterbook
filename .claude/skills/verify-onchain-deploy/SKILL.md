---
name: verify-onchain-deploy
description: Independently verify a Foundry contract deployment or transaction on Base mainnet via cast, rather than trusting reported success. Use after any `forge script --broadcast` deploy or any on-chain transaction in contracts/jensen-buyback-burn (or similar Foundry projects in this repo).
---

# Verify an on-chain deploy or transaction

The user runs deploy/transaction commands themselves (never this
session — see the repo's `CLAUDE.md` on secrets). When they report a
deploy address or a transaction hash, verify it directly rather than
taking the terminal output at face value. All commands below assume
`export PATH="$PATH:$HOME/.foundry/bin"` and running from the relevant
Foundry project directory (so `--rpc-url base` resolves via that
project's `foundry.toml`).

## For a new contract deployment

```bash
ADDR=<deployed address>

# 1. Real bytecode exists
cast code "$ADDR" --rpc-url base | head -c 60

# 2. Immutable/constructor params match what the deploy script set —
#    check every public immutable, not just one
cast call "$ADDR" "someParam()(uint256)" --rpc-url base

# 3. Confirm it's unfunded / in the expected starting state before the
#    user sends anything to it
cast call <TOKEN> "balanceOf(address)(uint256)" "$ADDR" --rpc-url base
```

Cross-reference the deploy script's constants directly (`cat
script/Deploy*.s.sol`) rather than assuming — a mismatch between what
was intended and what's actually deployed is exactly the kind of thing
this check exists to catch.

## For a transaction (e.g. after calling a function)

```bash
TX=<tx hash>
cast receipt "$TX" --rpc-url base
```

Check `status` is `1` (not just that the command didn't error). Then
decode any events you care about from `logs[].data` — don't stop at
"it succeeded":

```bash
cast abi-decode --input "f(<types of the non-indexed event fields>)" <data>
```

For a `SwapAndBurn`-style event, cross-check the decoded amount against
the raw `Transfer` log to the expected destination (e.g. burn address)
in the same receipt — the event and the actual token movement should
agree.

## If something reverted with no useful message

Don't reach for `cast run <txhash>` expecting a real remote trace — for
this repo specifically, any transaction touching a B20 tokenized-stock
token (NVDAc, etc.) will fail identically under `cast run` (it replays
locally via revm, same precompile limitation as `forge test
--fork-url`). Use the `trace-b20-locally` skill instead.
