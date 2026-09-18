---
name: verify-deployed-contract-version
description: Confirm a locally-installed dependency's source (forge install, npm, etc.) actually matches what's deployed at a specific on-chain address, before hardcoding an interface, struct, or ABI against it. Use before integrating any new protocol contract, and any time behavior against a real deployed contract doesn't match what the installed source implies.
---

# Verify a dependency version against the real deployment

`forge install`/`npm install` fetch whatever the default branch or
latest tag happens to be — not necessarily what's actually deployed at
the address you're about to hardcode. A mismatch here is silent: the
code compiles fine, and only fails (often with a useless error) against
the real contract. This is exactly what caused two failed mainnet
`swapAndBurn()` calls in `contracts/jensen-buyback-burn` — a newer
`v4-periphery` added a struct field that Base's actually-deployed
Universal Router (pinned to an older `universal-router` release)
doesn't have.

## Procedure

1. **Get the deployed contract's real shape from a block explorer.**
   `WebFetch` on `https://basescan.org/address/<addr>#code` (or the
   equivalent explorer for the chain in question). Ask specifically for:
   contract name, constructor parameters (their names/order/types, not
   just count), and any struct/interface fields visible in the ABI that
   you're about to depend on. If an Etherscan-family v2 API key is
   available, `getsourcecode` gives this more precisely than the
   HTML page.

2. **Find the matching tagged release upstream.**
   ```bash
   gh api repos/<org>/<repo>/tags --paginate -q '.[].name'
   ```
   Pick a few candidate tags (start with ones released before/around
   when the contract was likely deployed) and diff the specific
   struct/interface/constructor you care about across them:
   ```bash
   gh api "repos/<org>/<repo>/contents/<path>?ref=<tag>" -q '.content' | base64 -d
   ```
   Look for the tag whose shape matches the deployed contract's
   constructor/ABI **exactly** — field-for-field, not just "looks close."

3. **If there's a pinned sub-dependency**, get its exact commit too
   (submodules show up in a repo's tree with a `submodule_git_url` +
   `sha`):
   ```bash
   gh api "repos/<org>/<repo>/contents/<submodule-path>?ref=<tag>"
   ```

4. **Reconcile.** Either reinstall the local dependency at the matching
   tag/commit, or — often simpler and more explicit — declare the
   specific struct/interface locally rather than importing the
   (mismatched) newer version, with a comment stating which real
   deployment and which upstream commit it was verified against and
   why it deliberately differs from what's currently installed.

## When to reach for this

- Before hardcoding any new protocol address this codebase will call
  directly (a router, a factory, a pool manager, etc.) — not just when
  something's already broken.
- When a call against a real deployed contract fails in a way the
  installed source doesn't explain (wrong revert, unexpected
  zero-length revert, a function that "should" exist per the installed
  ABI but doesn't).
- Periodically for addresses this repo already depends on, if the
  installed dependency gets bumped for an unrelated reason — a version
  bump can silently invalidate a match that used to hold.
