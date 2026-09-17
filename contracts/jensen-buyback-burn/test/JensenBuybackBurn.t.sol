// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JensenBuybackBurn} from "../src/JensenBuybackBurn.sol";

/// @notice Test-only harness exposing JensenBuybackBurn's internal TWAP/
/// quote math for direct assertions, without changing anything about the
/// deployed contract's real interface.
contract JensenBuybackBurnHarness is JensenBuybackBurn {
    constructor(
        uint256 _minSwapThresholdUsdc,
        uint256 _callerTipBps,
        uint256 _maxSlippageBpsAerodromeLeg,
        uint256 _maxSlippageBpsJensenLeg,
        uint128 _maxNvdacPerCallJensenLeg,
        uint32 _twapWindowSeconds
    )
        JensenBuybackBurn(
            _minSwapThresholdUsdc,
            _callerTipBps,
            _maxSlippageBpsAerodromeLeg,
            _maxSlippageBpsJensenLeg,
            _maxNvdacPerCallJensenLeg,
            _twapWindowSeconds
        )
    {}

    function exposed_aerodromeMinOut(uint256 amountInUsdc) external view returns (uint256) {
        return _aerodromeMinOut(amountInUsdc);
    }

    function exposed_getQuoteAtTick(int24 tick, uint256 baseAmount, address baseToken, address quoteToken)
        external
        pure
        returns (uint256)
    {
        return _getQuoteAtTick(tick, baseAmount, baseToken, quoteToken);
    }
}

/// @notice Fork tests against real, live Base mainnet state
/// (forge test --fork-url base -vvv).
///
/// IMPORTANT, discovered while writing these tests, not assumed going in:
/// NVDAc — like every Coinbase B20 tokenized-stock token — has no real EVM
/// bytecode of its own (`eth_getCode` returns a single byte, `0xef`). Base's
/// own L2 client dispatches calls to these addresses through a chain-level
/// precompile that only the real network implements; Foundry's local fork
/// simulation (Anvil/revm) cannot execute any call into NVDAc at all —
/// confirmed directly: even a plain `approve()` reverts with
/// `EvmError: OpcodeNotFound`. This is a hard tooling limitation, not a bug
/// in the contract, and it means:
///
///   - The full swapAndBurn() flow, and anything touching the JENSEN leg,
///     CANNOT be exercised in a local fork test, regardless of how the
///     contract is written. This is why JensenBuybackBurn's constructor was
///     deliberately reworked to be USDC-only (NVDAc-side approvals happen
///     lazily, on first real call) — so at least everything up to that
///     point stays testable here.
///   - What CAN be verified locally, and is: the threshold/tip logic
///     (USDC-only), and — importantly — the TWAP-based slippage-protection
///     math for the Aerodrome leg, which only calls the real (bytecode-
///     backed) Aerodrome pool and USDC, never NVDAc directly.
///   - The JENSEN leg, and a full end-to-end run, can only be verified for
///     real on Base mainnet itself. See the deploy script's README section
///     for the required small real-money manual test before trusting this
///     with anything automatic.
contract JensenBuybackBurnTest is Test {
    JensenBuybackBurnHarness internal jbb;

    address internal caller = makeAddr("keeper");

    uint256 internal constant MIN_THRESHOLD = 50e6; // $50 USDC
    uint256 internal constant CALLER_TIP_BPS = 75; // 0.75%
    uint256 internal constant MAX_SLIPPAGE_AERO_BPS = 100; // 1%
    uint256 internal constant MAX_SLIPPAGE_JENSEN_BPS = 500; // 5%
    uint128 internal constant MAX_NVDAC_PER_CALL = 2e8; // 2 NVDAc (8 decimals)
    uint32 internal constant TWAP_WINDOW = 1800; // 30 min

    function setUp() public {
        jbb = new JensenBuybackBurnHarness(
            MIN_THRESHOLD, CALLER_TIP_BPS, MAX_SLIPPAGE_AERO_BPS, MAX_SLIPPAGE_JENSEN_BPS, MAX_NVDAC_PER_CALL, TWAP_WINDOW
        );
    }

    function _fundUsdc(uint256 amount) internal {
        address usdc = address(jbb.USDC());
        deal(usdc, address(jbb), IERC20(usdc).balanceOf(address(jbb)) + amount);
    }

    // ── Constructor sanity ─────────────────────────────────────────────

    function test_constructor_rejectsExcessiveTip() public {
        vm.expectRevert(bytes("tip too high"));
        new JensenBuybackBurnHarness(MIN_THRESHOLD, 501, MAX_SLIPPAGE_AERO_BPS, MAX_SLIPPAGE_JENSEN_BPS, MAX_NVDAC_PER_CALL, TWAP_WINDOW);
    }

    function test_constructor_rejectsExcessiveAeroSlippage() public {
        vm.expectRevert(bytes("slippage too high"));
        new JensenBuybackBurnHarness(MIN_THRESHOLD, CALLER_TIP_BPS, 1001, MAX_SLIPPAGE_JENSEN_BPS, MAX_NVDAC_PER_CALL, TWAP_WINDOW);
    }

    function test_constructor_rejectsShortTwapWindow() public {
        vm.expectRevert(bytes("twap window too short"));
        new JensenBuybackBurnHarness(MIN_THRESHOLD, CALLER_TIP_BPS, MAX_SLIPPAGE_AERO_BPS, MAX_SLIPPAGE_JENSEN_BPS, MAX_NVDAC_PER_CALL, 30);
    }

    // ── Threshold / canExecute (USDC-only, no NVDAc touched) ───────────

    function test_canExecute_falseBelowThreshold() public {
        _fundUsdc(MIN_THRESHOLD - 1);
        assertFalse(jbb.canExecute());
    }

    function test_canExecute_trueAtThreshold() public {
        _fundUsdc(MIN_THRESHOLD);
        assertTrue(jbb.canExecute());
    }

    function test_revertsBelowThreshold() public {
        _fundUsdc(MIN_THRESHOLD - 1);
        vm.expectRevert(
            abi.encodeWithSelector(JensenBuybackBurn.BelowThreshold.selector, MIN_THRESHOLD - 1, MIN_THRESHOLD)
        );
        jbb.swapAndBurn();
    }

    // ── TWAP/quote math against the real, live Aerodrome pool ─────────
    // (Aerodrome's pool contract has real bytecode — this is a genuine
    // integration test against live mainnet state, not a mock.)

    function test_aerodromeMinOut_isPositiveAndBelowNaiveUpperBound() public view {
        uint256 amountInUsdc = 100e6; // $100
        uint256 minOut = jbb.exposed_aerodromeMinOut(amountInUsdc);
        assertGt(minOut, 0, "expected a positive minOut for a real $100 input");

        // Sanity ceiling: NVDAc has never traded anywhere near $1/share on
        // this pool (it tracks NVDA, currently in the hundreds of dollars),
        // so $100 should buy meaningfully less than 100 whole NVDAc
        // (100e8 raw units, 8 decimals) — catches a decimals/units bug
        // without hardcoding a brittle exact price expectation.
        assertLt(minOut, 100e8, "minOut implausibly high for $100 in - likely a units/decimals bug");
    }

    function test_aerodromeMinOut_scalesRoughlyLinearlyWithInput() public view {
        uint256 small = jbb.exposed_aerodromeMinOut(10e6);
        uint256 large = jbb.exposed_aerodromeMinOut(1000e6);
        // 100x the input should give roughly 100x the output (within 5%,
        // loose enough to tolerate the pool's real, small in-range price
        // curvature at these sizes relative to its multi-million-dollar
        // depth) — a basic check that the math isn't doing something
        // degenerate like ignoring amountInUsdc.
        uint256 expectedLarge = small * 100;
        uint256 lowerBound = (expectedLarge * 95) / 100;
        uint256 upperBound = (expectedLarge * 105) / 100;
        assertGe(large, lowerBound, "output didn't scale up with input as expected");
        assertLe(large, upperBound, "output scaled up more than expected - check for a math bug");
    }

    function test_getQuoteAtTick_matchesKnownIdentityAtTickZero() public view {
        // At tick 0, price is exactly 1:1 in raw units regardless of which
        // token is "base" — a simple, hardcoded-answer sanity check for
        // the tick-math port from Aerodrome's OracleLibrary.
        uint256 amount = 12345e6;
        uint256 quoted = jbb.exposed_getQuoteAtTick(0, amount, address(jbb.USDC()), address(jbb.NVDAC()));
        assertApproxEqAbs(quoted, amount, 1, "tick-0 quote should be ~1:1 in raw units");
    }

    // ── What's NOT tested here, and why ────────────────────────────────
    // swapAndBurn()'s full flow (the Aerodrome swap execution, the entire
    // JENSEN/Uniswap-V4 leg, the burn) cannot be exercised in this fork
    // environment — see this file's header comment. That verification
    // happens as a real, small, manual mainnet transaction instead, per
    // the deploy script's documented rollout steps.
}
