// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ICLPool} from "contracts/core/interfaces/ICLPool.sol";
import {ISwapRouter as IAeroSwapRouter} from "contracts/periphery/interfaces/ISwapRouter.sol";

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @title Permit2's allowance-transfer interface (canonical deployment, same
/// address on every EVM chain including Base) — the Universal Router pulls
/// input tokens through this, not via plain ERC20 allowance.
interface IAllowanceTransfer {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @title Minimal Universal Router interface — only the one entry point
/// this contract needs, verified against Uniswap's real IUniversalRouter.sol
/// rather than the whole dependency's import chain.
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @title JensenBuybackBurn
/// @notice Permissionless, immutable: takes whatever USDC this contract
/// holds, swaps it to NVDAc on Aerodrome Slipstream, then NVDAc to JENSEN on
/// Uniswap V4 (the only pool JENSEN trades on — it has no direct USDC pair),
/// and burns the JENSEN. No owner, no pause, no upgrade path — the only way
/// to change behavior is to deploy a new contract.
///
/// SECURITY NOTE, read before trusting this with meaningful volume: this
/// was designed and researched carefully, but is NOT a substitute for a
/// professional smart-contract audit. Real funds move through this
/// contract. See the deploy script and README in this directory for the
/// full reasoning, especially around the JENSEN/Uniswap-V4 leg, whose
/// custom Doppler fee hook has oracle behavior this contract's author could
/// not independently verify — that leg is protected primarily by a hard
/// per-call size cap, not a manipulation-resistant TWAP (unlike the
/// Aerodrome leg, which does use one).
contract JensenBuybackBurn is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    // ── Protocol addresses (Base mainnet) ──────────────────────────────
    // Every address below was independently verified on-chain (eth_getCode
    // / matching factory() calls / cross-referencing multiple sources)
    // before being hardcoded here — see the deploy script's header comment
    // for the verification notes. Re-verify against Aerodrome's and
    // Uniswap's own docs one more time before ever redeploying this.

    IERC20 public constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IERC20 public constant NVDAC = IERC20(0xb20000000000000000000078ee7ce2fE4908108C);
    IERC20 public constant JENSEN = IERC20(0x84856D2a71e5D47535AC58B57729351766e89ba3);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // Aerodrome Slipstream — the same deep (~$2M+) USDC/NVDAc pool this
    // contract's sibling app (afterbook.app) already reads slot0() from.
    // token0 = USDC, token1 = NVDAc (verified in that app's own tokens.ts).
    address public constant AERODROME_POOL = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;
    IAeroSwapRouter public constant AERODROME_ROUTER = IAeroSwapRouter(0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F);
    int24 public constant AERODROME_TICK_SPACING = 10;

    // Uniswap V4 — JENSEN's only pool, paired with NVDAc, carrying a
    // permanent Doppler/Bankr fee hook. currency0 = JENSEN, currency1 =
    // NVDAc (JENSEN's address sorts lower), confirmed by decoding the
    // pool's own Initialize event.
    IPoolManager public constant V4_POOL_MANAGER = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IUniversalRouter public constant UNIVERSAL_ROUTER = IUniversalRouter(0x6fF5693b99212Da76ad316178A184AB56D299b43);
    IAllowanceTransfer public constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    address public constant DOPPLER_HOOK = 0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544;
    uint24 public constant JENSEN_POOL_FEE = 0x800000; // dynamic-fee flag, not a literal bps value
    int24 public constant JENSEN_POOL_TICK_SPACING = 200;

    // Universal Router command + V4Router action bytes, per Uniswap's own
    // Commands.sol / Actions.sol.
    uint256 private constant CMD_V4_SWAP = 0x10;
    uint256 private constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    uint256 private constant ACTION_SETTLE_ALL = 0x0c;
    uint256 private constant ACTION_TAKE_ALL = 0x0f;

    // ── Deploy-time, immutable configuration ───────────────────────────

    /// @notice Minimum USDC balance (6 decimals) before a call will execute.
    uint256 public immutable minSwapThresholdUsdc;
    /// @notice Caller incentive, taken from the USDC balance before
    /// swapping, in basis points.
    uint256 public immutable callerTipBps;
    /// @notice Slippage tolerance for the Aerodrome (USDC->NVDAc) leg,
    /// applied on top of a TWAP-derived expected output.
    uint256 public immutable maxSlippageBpsAerodromeLeg;
    /// @notice Slippage tolerance for the JENSEN (V4) leg's same-block
    /// sanity check. This is NOT manipulation-resistant on its own — see
    /// maxNvdacPerCallJensenLeg, the actual defense for this leg.
    uint256 public immutable maxSlippageBpsJensenLeg;
    /// @notice Hard cap on how much NVDAc gets swapped into JENSEN in a
    /// single call, regardless of how much NVDAc this contract holds —
    /// bounds worst-case value at risk from a single manipulated call
    /// against JENSEN's thin, young pool. Any NVDAc above the cap simply
    /// waits for a future call.
    uint128 public immutable maxNvdacPerCallJensenLeg;
    /// @notice TWAP lookback window for the Aerodrome leg, in seconds.
    uint32 public immutable twapWindowSeconds;

    /// @dev Set on first successful call that reaches the JENSEN leg.
    /// Deliberately not done eagerly in the constructor: NVDAc (like every
    /// B20 tokenized-stock token) has no real EVM bytecode of its own —
    /// Base's own L2 client dispatches calls to it through a chain-level
    /// precompile — so a generic local EVM simulator can't execute any
    /// call into it at all. Keeping the constructor USDC-only means this
    /// contract (and everything upstream of the JENSEN leg) stays testable
    /// against a local fork; only the JENSEN leg itself needs real Base.
    bool private _nvdacApprovedForV4;

    // ── Events ──────────────────────────────────────────────────────────

    event SwapAndBurn(
        address indexed caller,
        uint256 usdcIn,
        uint256 tipPaid,
        uint256 nvdacSwapped,
        uint256 jensenBurned
    );

    // ── Errors ──────────────────────────────────────────────────────────

    error BelowThreshold(uint256 balance, uint256 threshold);
    error InsufficientAerodromeOutput(uint256 received, uint256 minRequired);
    error InsufficientJensenOutput(uint256 received, uint256 minRequired);
    error NothingToBurn();

    constructor(
        uint256 _minSwapThresholdUsdc,
        uint256 _callerTipBps,
        uint256 _maxSlippageBpsAerodromeLeg,
        uint256 _maxSlippageBpsJensenLeg,
        uint128 _maxNvdacPerCallJensenLeg,
        uint32 _twapWindowSeconds
    ) {
        require(_callerTipBps <= 500, "tip too high"); // sanity cap, 5%
        require(_maxSlippageBpsAerodromeLeg <= 1000, "slippage too high"); // 10%
        require(_maxSlippageBpsJensenLeg <= 2000, "slippage too high"); // 20%
        require(_twapWindowSeconds >= 60, "twap window too short");

        minSwapThresholdUsdc = _minSwapThresholdUsdc;
        callerTipBps = _callerTipBps;
        maxSlippageBpsAerodromeLeg = _maxSlippageBpsAerodromeLeg;
        maxSlippageBpsJensenLeg = _maxSlippageBpsJensenLeg;
        maxNvdacPerCallJensenLeg = _maxNvdacPerCallJensenLeg;
        twapWindowSeconds = _twapWindowSeconds;

        // One-time approvals to well-known, heavily audited infrastructure
        // contracts (Aerodrome's router, Permit2) — not a per-call cost,
        // and not a meaningfully larger trust surface than the swaps this
        // contract already performs through them.
        // Only USDC here — see _nvdacApprovedForV4's doc comment for why
        // the NVDAc-side approvals are deliberately not done eagerly.
        USDC.forceApprove(address(AERODROME_ROUTER), type(uint256).max);
    }

    /// @notice Anyone can call this. Reverts if there isn't enough USDC
    /// balance to be worth executing.
    function swapAndBurn() external nonReentrant returns (uint256 jensenBurned) {
        uint256 usdcBalance = USDC.balanceOf(address(this));
        if (usdcBalance < minSwapThresholdUsdc) revert BelowThreshold(usdcBalance, minSwapThresholdUsdc);

        uint256 tip = (usdcBalance * callerTipBps) / 10_000;
        uint256 amountIn = usdcBalance - tip;
        if (tip > 0) USDC.safeTransfer(msg.sender, tip);

        uint256 nvdacReceived = _swapUsdcToNvdac(amountIn);
        uint256 nvdacToSwap = nvdacReceived > maxNvdacPerCallJensenLeg ? maxNvdacPerCallJensenLeg : nvdacReceived;
        _swapNvdacToJensen(nvdacToSwap);

        // Burn the contract's entire held JENSEN balance, not just this
        // call's output — sweeps any dust from prior partial swaps too,
        // and (per a well-documented real exploit lesson) only ever burns
        // from this contract's own balance, never touches the pool.
        jensenBurned = JENSEN.balanceOf(address(this));
        if (jensenBurned == 0) revert NothingToBurn();
        JENSEN.safeTransfer(BURN_ADDRESS, jensenBurned);

        // Must come after the external calls — the final amounts aren't
        // known until they complete. The `nonReentrant` modifier on this
        // function already blocks the specific risk this lint flags (a
        // reentrant call reordering/fabricating this function's own log).
        // forge-lint: disable-next-line(reentrancy-events)
        emit SwapAndBurn(msg.sender, usdcBalance, tip, nvdacToSwap, jensenBurned);
    }

    /// @notice Cheap, no-state-change check for a keeper/caller to run
    /// before spending gas on swapAndBurn().
    function canExecute() external view returns (bool) {
        return USDC.balanceOf(address(this)) >= minSwapThresholdUsdc;
    }

    // ── Internal: Aerodrome leg (TWAP-protected) ───────────────────────

    function _swapUsdcToNvdac(uint256 amountIn) private returns (uint256 nvdacReceived) {
        uint256 minOut = _aerodromeMinOut(amountIn);

        uint256 balanceBefore = NVDAC.balanceOf(address(this));
        // amountOut is intentionally unused — nvdacReceived below is a
        // balance-delta check instead, which is the more defensive of the
        // two and makes trusting the router's own return value redundant.
        // forge-lint: disable-next-line(unused-return)
        AERODROME_ROUTER.exactInputSingle(
            IAeroSwapRouter.ExactInputSingleParams({
                tokenIn: address(USDC),
                tokenOut: address(NVDAC),
                tickSpacing: AERODROME_TICK_SPACING,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        // Balance-delta, not the router's return value — defensive against
        // any unexpected transfer behavior on either token.
        nvdacReceived = NVDAC.balanceOf(address(this)) - balanceBefore;
        if (nvdacReceived < minOut) revert InsufficientAerodromeOutput(nvdacReceived, minOut);
    }

    /// @dev Reimplements Aerodrome's own OracleLibrary.consult() +
    /// getQuoteAtTick() math (verified against the real, deployed
    /// contracts/periphery/libraries/OracleLibrary.sol in this repo's
    /// slipstream dependency) using v4-core's modern (^0.8.0) TickMath/
    /// FullMath instead of Aerodrome's <0.8.0-only copies, so it compiles
    /// under this contract's Solidity version. Same formulas, same
    /// interface (ICLPool.observe), not a reinvention.
    function _aerodromeMinOut(uint256 amountInUsdc) internal view returns (uint256 minOut) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindowSeconds;
        secondsAgos[1] = 0;

        // secondsPerLiquidityCumulativeX128s isn't needed — this only
        // consults the tick accumulator, not the liquidity oracle.
        // forge-lint: disable-next-line(unused-return)
        (int56[] memory tickCumulatives,) = ICLPool(AERODROME_POOL).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int56 window = int56(uint56(twapWindowSeconds));

        // delta/window is bounded by real tick range (~±887272) divided by
        // a >=60s window — nowhere near int24's range, same truncation
        // Aerodrome's own OracleLibrary.consult() performs.
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 avgTick = int24(delta / window);
        if (delta < 0 && (delta % window != 0)) avgTick--;

        uint256 expectedOut = _getQuoteAtTick(avgTick, amountInUsdc, address(USDC), address(NVDAC));
        minOut = expectedOut - ((expectedOut * maxSlippageBpsAerodromeLeg) / 10_000);
    }

    function _getQuoteAtTick(int24 tick, uint256 baseAmount, address baseToken, address quoteToken)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtPriceAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseToken < quoteToken
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    // ── Internal: JENSEN leg (size-capped, not TWAP-protected) ─────────

    /// @dev The Doppler hook's custom "Multicurve" liquidity means its
    /// oracle behavior isn't independently verified here, so — unlike the
    /// Aerodrome leg — this does NOT rely on a TWAP for its primary
    /// protection. The real defense is maxNvdacPerCallJensenLeg, enforced
    /// by the caller (swapAndBurn already clamps nvdacToSwap before this
    /// is called). The same-block price check here is only a sanity
    /// bound against a grossly wrong price, not a manipulation defense —
    /// documented as such rather than overstating what it protects
    /// against. V4's Quoter is deliberately not used on-chain: its own
    /// source (V4Quoter.sol) says outright it "should not be called
    /// on-chain."
    function _swapNvdacToJensen(uint256 amountIn) private {
        if (!_nvdacApprovedForV4) {
            NVDAC.forceApprove(address(PERMIT2), type(uint256).max);
            PERMIT2.approve(address(NVDAC), address(UNIVERSAL_ROUTER), type(uint160).max, type(uint48).max);
            _nvdacApprovedForV4 = true;
        }

        (uint160 sqrtPriceX96,,,) = V4_POOL_MANAGER.getSlot0(_jensenPoolKey().toId());
        uint256 expectedOut = _getQuoteAtTick(TickMath.getTickAtSqrtPrice(sqrtPriceX96), amountIn, address(NVDAC), address(JENSEN));
        uint256 minOut = expectedOut - ((expectedOut * maxSlippageBpsJensenLeg) / 10_000);

        uint256 balanceBefore = JENSEN.balanceOf(address(this));

        // These three action bytes are compile-time constants <= 0x0f —
        // trivially fit in uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory actions = abi.encodePacked(
            uint8(ACTION_SWAP_EXACT_IN_SINGLE), uint8(ACTION_SETTLE_ALL), uint8(ACTION_TAKE_ALL)
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            V4ExactInputSingleParams({
                poolKey: _jensenPoolKey(),
                zeroForOne: false, // NVDAc (currency1) -> JENSEN (currency0)
                // amountIn is always <= maxNvdacPerCallJensenLeg (a
                // uint128), clamped by the only caller, swapAndBurn().
                // forge-lint: disable-next-line(unsafe-typecast)
                amountIn: uint128(amountIn),
                // minOut <= expectedOut <= JENSEN's total raw supply
                // (~1e29), far under uint128's ~3.4e38 max.
                // forge-lint: disable-next-line(unsafe-typecast)
                amountOutMinimum: uint128(minOut),
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(Currency.wrap(address(NVDAC)), amountIn);
        params[2] = abi.encode(Currency.wrap(address(JENSEN)), minOut);

        // CMD_V4_SWAP is the compile-time constant 0x10 — fits in uint8.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory commands = abi.encodePacked(uint8(CMD_V4_SWAP));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        UNIVERSAL_ROUTER.execute(commands, inputs, block.timestamp);

        uint256 jensenReceived = JENSEN.balanceOf(address(this)) - balanceBefore;
        if (jensenReceived < minOut) revert InsufficientJensenOutput(jensenReceived, minOut);
    }

    function _jensenPoolKey() private pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(JENSEN)),
            currency1: Currency.wrap(address(NVDAC)),
            fee: JENSEN_POOL_FEE,
            tickSpacing: JENSEN_POOL_TICK_SPACING,
            hooks: IHooks(DOPPLER_HOOK)
        });
    }

    /// @dev Mirrors IV4Router.ExactInputSingleParams's field layout exactly
    /// as compiled into the REAL deployed Universal Router on Base
    /// (verified against v4-periphery commit 444c526b, the exact submodule
    /// ref pinned by universal-router@2.0.0 — the tag whose RouterParameters
    /// struct matches the deployed contract's constructor args on BaseScan).
    /// This intentionally does NOT match the newer v4-periphery installed
    /// under lib/ in this repo, which added a minHopPriceX36 field here —
    /// encoding that extra field is what caused every real swapAndBurn()
    /// call to revert: the deployed router's compiler-generated bounds
    /// check on the (differently-positioned) hookData field read garbage
    /// and hit calldata out-of-bounds, producing an empty revert with zero
    /// nested calls. Declared locally (not imported) to avoid pulling in
    /// the newer, mismatched IV4Router interface.
    struct V4ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }
}
