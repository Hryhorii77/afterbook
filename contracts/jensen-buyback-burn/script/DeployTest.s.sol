// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {JensenBuybackBurn} from "../src/JensenBuybackBurn.sol";

/// @notice THROWAWAY test deployment — same contract, same hardcoded
/// protocol addresses as Deploy.s.sol, but with a $1 threshold instead of
/// $50, purely so the first real end-to-end test (the required manual
/// verification step before trusting this with anything real) costs a
/// dollar instead of fifty. Not meant to be the contract you actually fund
/// for ongoing use — deploy the real one via Deploy.s.sol for that, once
/// this test confirms the mechanism works correctly on real mainnet.
///
/// Usage: forge script script/DeployTest.s.sol --rpc-url base --broadcast --account deployer
contract DeployTest is Script {
    uint256 constant MIN_SWAP_THRESHOLD_USDC = 1e6; // $1 — test only
    uint256 constant CALLER_TIP_BPS = 75;
    uint256 constant MAX_SLIPPAGE_BPS_AERODROME = 100;
    uint256 constant MAX_SLIPPAGE_BPS_JENSEN = 500;
    uint128 constant MAX_NVDAC_PER_CALL_JENSEN = 2e8;
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

        console.log("TEST JensenBuybackBurn deployed at:", address(jbb));
        console.log("This is a $1-threshold TEST deployment -- not the one to fund for real use.");
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Send $1-2 of USDC to the contract address above.");
        console.log("2. Call swapAndBurn() once, manually, via BaseScan's 'Write Contract' tab");
        console.log("   (or `cast send <address> \"swapAndBurn()\" --rpc-url base --account deployer`).");
        console.log("3. On BaseScan, confirm: you received the USDC tip, NVDAc was correctly bought");
        console.log("   on Aerodrome, JENSEN was correctly bought on Uniswap V4, and the JENSEN");
        console.log("   landed at the burn address (0x...dEaD).");
        console.log("4. Once confirmed, deploy the REAL contract via Deploy.s.sol ($50 threshold)");
        console.log("   for actual ongoing use -- this test contract can just be abandoned.");
    }
}
