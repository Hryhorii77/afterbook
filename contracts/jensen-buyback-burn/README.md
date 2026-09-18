# $JENSEN buyback-and-burn

A standalone, immutable Solidity contract that turns accumulated USDC into
$JENSEN burn pressure — the deferred piece of the $JENSEN utility idea from
afterbook.app's build-out. **Entirely separate from the Afterbook Next.js
app**: different toolchain (Foundry, not npm/Vercel), different deploy path
(your own key, from your own machine), no shared code or config.

## Why this is more complex than it might look

$JENSEN has no USDC pair. It only trades against **NVDAc** (one of
Afterbook's own ten tracked tokenized stocks) on a single **Uniswap V4**
pool carrying a permanent Doppler/Bankr fee hook. So turning USDC into
burned JENSEN is a two-hop route across two different AMM architectures:

1. **USDC → NVDAc** on Aerodrome Slipstream (deep liquidity, ~$2M+, the
   same pool afterbook.app already reads `slot0()` from every 20 seconds).
2. **NVDAc → JENSEN** on Uniswap V4 (thin, ~$20k liquidity, 6 days old at
   time of writing, routed through Uniswap's Universal Router since V4's
   flash-accounting design means a plain contract can't call the pool
   directly).

## Security posture — read this before trusting it with real money

**This was designed and researched carefully, but it is not a substitute
for a professional smart-contract audit.** Real funds move through this
contract. Specific things worth knowing:

- **No owner, no pause, no upgrade path.** Every constructor parameter is
  immutable. The only way to change behavior is to deploy a new contract.
  This is deliberate — it matches the rest of this project's "nothing is
  ever custodied, nothing is ever a privileged role" posture — but it also
  means there's no emergency stop if something's wrong. Test small first.
- **The Aerodrome leg uses a real TWAP** (30-minute default), reusing
  Aerodrome's own `OracleLibrary` math (re-expressed for a modern Solidity
  version, verified against their actual deployed library source — not
  reinvented). Same-block spot price is never trusted for this leg.
- **The JENSEN/Uniswap-V4 leg does NOT use a TWAP.** Its Doppler hook uses
  custom "Multicurve" liquidity, and this contract's author could not
  independently verify that hook's oracle behaves safely for TWAP purposes
  without far deeper research into an unaudited-by-us hook than was
  reasonable to do here. Instead, this leg is protected primarily by a
  **hard per-call size cap** (`maxNvdacPerCallJensenLeg`) — bounding the
  maximum value ever at risk in a single call to a small, deliberately
  chosen amount — plus a same-block sanity check that's explicitly *not*
  manipulation-resistant on its own. Any NVDAc above the cap just waits for
  a future call rather than being force-swapped all at once.
- **Uniswap's own V4 Quoter is deliberately not called on-chain** — its
  source literally says "these functions... should not be called
  on-chain." Using it here would have added gas cost and false confidence,
  not real protection.
- **Lesson applied from a real, exploited buyback-and-burn bug** (SafeMoon,
  ~$8.9M, 2023): this contract only ever burns tokens it already holds in
  its own balance (`JENSEN.balanceOf(address(this))`), never touches a
  pool's reserves directly.
- **Balance-delta accounting throughout**, not trust in a swap's return
  value or a transfer's nominal amount — defensive against any unexpected
  token transfer behavior.

## A real bug, found and fixed after two failed mainnet calls

The first two real `swapAndBurn()` attempts (on a throwaway $1-threshold test
deployment) reverted with no usable error message. Root cause, found by
replaying the failure locally with NVDAc's address `vm.etch`'d to a plain
ERC20 mock (the only way to get a full trace — see the limitation below):
this contract's `V4ExactInputSingleParams` struct had an extra
`minHopPriceX36` field that doesn't exist in the version of Universal
Router actually deployed on Base. `forge install`'s default branch pulled
a newer `v4-periphery` (which added that field); the real deployed router
is pinned to `universal-router@2.0.0`, whose `ExactInputSingleParams` has
one field fewer. The extra field shifted every subsequent word, so the
router's compiler-generated bounds check on the (now differently
positioned) `hookData` field read garbage as a length and hit calldata
out-of-bounds — a bare, zero-length revert, before any nested call. Fixed
by matching the struct to the real deployed router's layout (verified via
BaseScan's `RouterParameters` ABI cross-referenced against tagged releases
of `Uniswap/universal-router` on GitHub, not just whatever `forge install`
happens to fetch).

Consequence: the $1-threshold test contract deployed with the buggy code
is permanently stuck holding ~$11 USDC (no owner, no rescue function, and
`swapAndBurn()` can never succeed on that specific immutable deployment —
by design there's no way around this). The real $50-threshold contract was
never funded, so this cost was contained to the test deployment it was
built for. Both should be treated as abandoned; redeploy fresh from the
fixed source.

## A real tooling limitation, discovered while testing

Coinbase's B20 tokenized-stock standard (which NVDAc belongs to) has no
real EVM bytecode — `eth_getCode` on NVDAc returns a single byte (`0xef`).
Base's own L2 client dispatches calls to these addresses through a
chain-level precompile that only the real network implements. **Foundry's
local fork simulation cannot execute any call into NVDAc at all** —
confirmed directly (a plain `approve()` reverts with `OpcodeNotFound`).

Practical consequences:
- The constructor is deliberately USDC-only (NVDAc-side approvals happen
  lazily, on the first real call) so at least deployment and everything
  upstream of the JENSEN leg stays testable locally.
- `test/JensenBuybackBurn.t.sol` fork-tests everything that's genuinely
  testable this way: the threshold/tip logic, and — importantly — the
  TWAP-based slippage-protection math for the Aerodrome leg (verified
  against real live mainnet state; a $100 input was confirmed to imply
  ~$221/NVDAc, matching NVDAc's real live price at the time).
- **The full `swapAndBurn()` flow, and the entire JENSEN leg, can only be
  verified for real on Base mainnet itself.** See "Deploying" below.

## Setup

`lib/` (Foundry's vendored dependencies, ~200MB) isn't committed. Reinstall
before building:

```bash
export PATH="$PATH:$HOME/.foundry/bin"  # if not already on PATH, after `curl -L https://foundry.paradigm.xyz | bash && foundryup`
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install aerodrome-finance/slipstream --no-git
forge install Uniswap/v4-core --no-git
forge install Uniswap/v4-periphery --no-git
forge install Uniswap/universal-router --no-git
forge install Uniswap/permit2 --no-git
```

## Deploying

```bash
forge test --fork-url base -vv          # run the test suite first
forge script script/Deploy.s.sol --rpc-url base   # dry-run, no broadcast
```

Deploy for real (from your own machine, with your own key — never
hosted/CI, same trust posture as everything else in this project):

```bash
forge script script/Deploy.s.sol --rpc-url base --broadcast \
  --private-key <YOUR_KEY> --verify --etherscan-api-key <BASESCAN_KEY>
```

**Before running this for real**: re-verify every hardcoded address in
`src/JensenBuybackBurn.sol` against Aerodrome's and Uniswap's current
official docs one more time — they were independently verified (on-chain
`eth_getCode`, matching `factory()` calls against the actual pool in use,
cross-referencing Uniswap's official developers.uniswap.org and Aerodrome's
own deployment-address files) as of when this was written, but deployments
change over time.

**After deploying**: this is the required first real test, not optional —

1. Send a couple dollars of USDC to the deployed contract address.
2. Call `swapAndBurn()` once, manually (BaseScan's "Write Contract" tab, or
   `cast send <address> "swapAndBurn()" --rpc-url base --private-key ...`).
3. Confirm on BaseScan: you (the caller) received the USDC tip, NVDAc was
   correctly bought on Aerodrome, JENSEN was correctly bought on Uniswap
   V4, and the JENSEN landed at the burn address
   (`0x000000000000000000000000000000000000dEaD`) — **before** sending
   anything larger or automated.
4. Only after that succeeds, decide separately whether to point
   afterbook.app's `X402_PAYOUT_ADDRESS` at this contract for automatic
   funding — not part of this deploy, a deliberate later decision.
