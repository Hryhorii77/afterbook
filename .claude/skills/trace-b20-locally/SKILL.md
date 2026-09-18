---
name: trace-b20-locally
description: Get a full local Foundry trace for a call that touches a Coinbase B20 tokenized-stock token (NVDAc, AAPLc, etc.) or otherwise reverts on Base mainnet with no useful error. Use when a transaction in contracts/jensen-buyback-burn (or any B20-touching flow) reverts with an empty/unhelpful message and forge test --fork-url or cast run both fail with OpcodeNotFound.
---

# Trace a B20-touching call locally

B20 tokenized-stock tokens have no real EVM bytecode (`eth_getCode`
returns a single byte) — Base's L2 client dispatches calls to them via a
chain-level precompile that **no local tool can execute**. This breaks
the two obvious diagnostic paths:

- `forge test --fork-url base -vvvv` on a test that calls into the
  token → `OpcodeNotFound`.
- `cast run <txhash> --rpc-url base` on a real historical transaction
  that touched the token → also `OpcodeNotFound` (it replays locally via
  revm, same limitation — not a real remote trace).
- The public `mainnet.base.org` RPC doesn't support
  `debug_traceTransaction`, so there's no remote-tracing fallback
  without a paid archive-node provider.

## The workaround: `vm.etch()` substitution

Replace the token's bytecode with a plain, working ERC20 mock **at the
same address**, so every hardcoded reference to that address in the real
contract under test still resolves correctly — only the unsimulable
precompile logic gets swapped out.

```solidity
import {MockERC20} from "permit2/test/mocks/MockERC20.sol";

address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;

function test_traceFullFlow() public {
    MockERC20 mock = new MockERC20("NVDAc", "NVDAc", 8); // match real decimals
    vm.etch(NVDAC, address(mock).code);
    MockERC20(NVDAC).mint(<wherever it needs a starting balance>, <amount>);

    // now call the real flow — every NVDAC.balanceOf/transfer/approve
    // call executes against the mock, everything else (Aerodrome,
    // Universal Router, the real V4 pool, the real Doppler hook) is the
    // real, live, forked mainnet state
    try target.someFunction() {
        console.log("SUCCEEDED");
    } catch (bytes memory lowLevelData) {
        console.log("REVERT length:", lowLevelData.length);
        console.logBytes(lowLevelData);
    }
}
```

Run with `forge test --match-path <file> --fork-url base -vvvv` and read
the full trace — this is the only way to see what happens *inside* a
call that touches NVDAc, including nested calls, gas per frame, and
exact revert points.

## Reading a zero-length revert in the trace

If the trace shows a revert with **zero nested calls and zero-length
revert data** right after a decode step (e.g. inside
`UniversalRouter.unlockCallback`), that's the signature of a
Solidity-compiler-generated calldata bounds check failing — not a
custom error, not an explicit `require` message. This almost always
means the calldata you constructed doesn't match what the receiving
contract's compiled struct/interface actually expects. See this
project's `CLAUDE.md` ("The rule that would have prevented the worst bug
here") for the exact diagnostic path: verify the installed dependency
source actually matches the deployed bytecode, don't just trust
`forge install`'s default branch.

## Caveat

This is diagnostic-only, not a correctness test. `MockERC20` doesn't
necessarily replicate every real B20 behavior (transfer restrictions,
`multiplier()` handling, etc.) — a flow that succeeds against the mock
still needs to be confirmed for real, small, on mainnet before trusting
it. Use `verify-onchain-deploy` for that step.
