# jensen-buyback-burn — working conventions

Standalone Foundry project. See `README.md` for what this contract does,
its security posture, and the addresses it uses. This file is about how
to work on it safely and effectively — lessons paid for the hard way.

## The rule that would have prevented the worst bug here

**Never trust `forge install`'s default branch to match what's actually
deployed on-chain.** The real bug behind two failed mainnet
`swapAndBurn()` calls: `forge install Uniswap/universal-router` (and its
own nested `v4-periphery`) pulled a newer commit than the router actually
deployed at the hardcoded Base address. The newer `ExactInputSingleParams`
struct had an extra field; encoding against it silently corrupted the
calldata layout the real (older) router expected, and the real router's
calldata bounds check on the shifted `hookData` field produced a bare,
zero-length revert — no useful error, twice, on real transactions.

Before hardcoding any interface/struct from a `lib/` dependency that will
be used against a **specific deployed contract address**, verify the
installed source actually matches that deployment — use the
`verify-deployed-contract-version` skill for the exact procedure
(BaseScan for the real shape, `gh api` against the dependency's tagged
releases to find the matching version).

This applies to any hardcoded protocol address in `src/JensenBuybackBurn.sol`
(Aerodrome router/quoter, Universal Router, V4 PoolManager, Permit2) —
re-verify against the real deployed bytecode before ever changing one,
not just against docs or a research agent's prose.

## The B20 local-simulation limitation

Coinbase's B20 tokenized-stock tokens (NVDAc, used here) have no real EVM
bytecode — `eth_getCode` returns a single byte. Base's own L2 client
dispatches calls to them through a chain-level precompile that **no local
tool can execute**: not Foundry's Anvil/revm fork (`forge test
--fork-url`), and not `cast run <txhash>` either (it also replays locally
via revm, so it hits the identical `OpcodeNotFound` wall on any real
historical transaction that touches NVDAc — it is not a way to get a real
remote trace). The public `mainnet.base.org` RPC also doesn't support
`debug_traceTransaction`, so there's no remote-tracing fallback either
without a paid archive-node provider.

**The only way to get a full local trace of anything touching NVDAc**:
`vm.etch()` NVDAc's address with a plain `MockERC20`'s bytecode before the
test runs, then mint it a working balance wherever it's needed (e.g. the
Aerodrome pool). This preserves every hardcoded address reference in the
real contract while replacing the unsimulable precompile with working
ERC20 logic. See `test/DebugFullFlow.t.sol` for the reference
implementation — it's the tool that actually found the real bug above,
after direct mainnet replay attempts (`cast run`) gave nothing usable.
Treat it as the standard diagnostic pattern for any future issue in the
JENSEN leg, not a one-off hack.

This tool is diagnostic-only, not a correctness test — a `MockERC20`
doesn't necessarily replicate every real B20 behavior. Real correctness
still has to be confirmed on real mainnet, with real (small) money, per
the deploy checklist below.

## Deploying

Deploys run from the **user's own terminal**, with the user's own key
(`--account <keystore>`), never through this session — see the root
`CLAUDE.md`'s secrets section. This project's role is: help pick/verify
parameters, review the script, and — after the user reports a deploy or
a transaction hash — **independently verify it on-chain**, every time,
rather than trust the reported success:

```bash
cast code <addr> --rpc-url base                          # has real bytecode
cast call <addr> "someImmutableGetter()(uint256)" --rpc-url base  # matches the script's constants
cast call <USDC> "balanceOf(address)(uint256)" <addr> --rpc-url base
cast receipt <txhash> --rpc-url base                      # status 1, decode logs
```

For a `swapAndBurn()` call specifically, decode the `SwapAndBurn` event
from the receipt (`cast abi-decode --input "f(uint256,uint256,uint256,uint256)" <data>`
against the non-indexed fields) and cross-check `jensenBurned` against the
raw `Transfer`-to-`0x...dEaD` log in the same receipt — don't just check
`status: 1`.

Always test a **new** deployment small before trusting it with real
volume — this contract is immutable with no owner/pause/rescue by design,
so a bug found after funding it is unrecoverable (as happened to the
first, buggy test deployment: ~$11 permanently stuck). `DeployTest.s.sol`
exists for exactly this — redeploy it fresh (new address) whenever the
contract source changes, don't assume an old test deployment's address is
still relevant once the code has moved.
