// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {JensenBuybackBurn} from "../src/JensenBuybackBurn.sol";

/// @notice Deploys JensenBuybackBurn to Base mainnet using YOUR OWN key —
/// this script is meant to be run from your own machine, never by an
/// assistant or any hosted/CI environment. It never touches the app's
/// (afterbook.app's) Vercel deployment or its env vars.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url base --broadcast \
///     --private-key <YOUR_KEY> --verify --etherscan-api-key <BASESCAN_KEY>
///
/// (Or use --interactive / a keystore instead of a raw --private-key, per
/// Foundry's own docs, if you'd rather not put a key on the command line.)
///
/// BEFORE RUNNING THIS FOR REAL: re-verify every hardcoded address in
/// JensenBuybackBurn.sol against Aerodrome's and Uniswap's own current docs
/// one more time. They were independently verified (eth_getCode, matching
/// factory() calls, cross-referencing multiple sources including Uniswap's
/// official developers.uniswap.org and Aerodrome's own deployment-address
/// JSON files) as of the time this was written — but re-check before
/// trusting real money to them, since deployments can and do change.
contract Deploy is Script {
    // ── Suggested starting parameters — deliberately conservative given
    // JENSEN's pool is thin (~$20k) and young. Tune before deploying, but
    // err small: it's far easier to redeploy with larger limits once this
    // has a track record than to walk back a loss.

    /// Minimum USDC balance before a call executes. $50 — small revenue
    /// (e.g. from the x402 paid API at $0.02/call) won't trigger a swap
    /// until it's actually worth the JENSEN pool's ~1.75% built-in fee.
    uint256 constant MIN_SWAP_THRESHOLD_USDC = 50e6;

    /// Caller incentive, paid in USDC before any swap happens. 0.75%.
    uint256 constant CALLER_TIP_BPS = 75;

    /// Slippage tolerance for the Aerodrome (USDC->NVDAc) leg, on top of a
    /// real 30-minute TWAP. 1% — this leg has deep, well-understood
    /// liquidity, so a tight tolerance is reasonable.
    uint256 constant MAX_SLIPPAGE_BPS_AERODROME = 100;

    /// Slippage tolerance for the JENSEN (Uniswap V4) leg's same-block
    /// sanity check — NOT the primary defense for this leg, see
    /// MAX_NVDAC_PER_CALL_JENSEN below. Wider (5%) because this check is
    /// explicitly not manipulation-resistant and shouldn't be relied on to
    /// be precise.
    uint256 constant MAX_SLIPPAGE_BPS_JENSEN = 500;

    /// Hard cap on NVDAc swapped into JENSEN per call — the real defense
    /// for the thin, young JENSEN/NVDAc pool. 2 NVDAc (~$400-450 at
    /// recent prices) is roughly 2% of that pool's total liquidity as of
    /// when this was written. Re-check the pool's current depth
    /// (dexscreener.com/base/<JENSEN token address>) before deploying —
    /// if it's grown, this cap can reasonably grow too; if it's shrunk,
    /// lower it.
    uint128 constant MAX_NVDAC_PER_CALL_JENSEN = 2e8; // 8 decimals

    /// TWAP lookback window for the Aerodrome leg. 30 minutes, matching
    /// Aerodrome's own documented convention for flash-loan-resistant
    /// pricing.
    uint32 constant TWAP_WINDOW_SECONDS = 1800;

    function run() external returns (JensenBuybackBurn jbb) {
        vm.startBroadcast();

        jbb = new JensenBuybackBurn(
            MIN_SWAP_THRESHOLD_USDC,
            CALLER_TIP_BPS,
            MAX_SLIPPAGE_BPS_AERODROME,
            MAX_SLIPPAGE_BPS_JENSEN,
            MAX_NVDAC_PER_CALL_JENSEN,
            TWAP_WINDOW_SECONDS
        );

        vm.stopBroadcast();

        console.log("JensenBuybackBurn deployed at:", address(jbb));
        console.log("");
        console.log("NEXT STEPS (do not skip):");
        console.log("1. Send a couple dollars of USDC to the contract address above.");
        console.log("2. Call swapAndBurn() once, manually, via BaseScan's 'Write Contract' tab");
        console.log("   (or `cast send <address> \"swapAndBurn()\" --rpc-url base --private-key ...`).");
        console.log("3. On BaseScan, confirm: the caller (you) received the USDC tip, NVDAc was");
        console.log("   correctly bought on Aerodrome, JENSEN was correctly bought on Uniswap V4,");
        console.log("   and the JENSEN landed at the burn address (0x...dEaD) -- before sending any");
        console.log("   further, larger, or automated USDC to this contract.");
        console.log("4. Only after that succeeds, consider whether to point X402_PAYOUT_ADDRESS at");
        console.log("   this contract for automatic funding -- a separate, later decision.");
    }
}
