// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "permit2/test/mocks/MockERC20.sol";
import {JensenBuybackBurnHarness} from "./JensenBuybackBurn.t.sol";

/// @notice Diagnostic-only: patches NVDAc's real address with a plain
/// ERC20 mock (preserving the address, replacing only the precompile-stub
/// bytecode) so the FULL swapAndBurn() flow -- including the JENSEN leg,
/// impossible to trace otherwise -- can run locally with a full trace.
/// Not a correctness test (NVDAc's real precompile behavior may differ in
/// ways a plain ERC20 mock can't capture) -- purely to see WHERE execution
/// reverts, since real mainnet attempts gave no usable trace.
contract DebugFullFlow is Test {
    address constant NVDAC = 0xb20000000000000000000078ee7ce2fE4908108C;
    address constant AERODROME_POOL = 0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9;

    function test_fullFlowTrace() public {
        MockERC20 mock = new MockERC20("NVDAc", "NVDAc", 8);
        vm.etch(NVDAC, address(mock).code);
        MockERC20(NVDAC).mint(AERODROME_POOL, 1_000_000e8); // deep enough to pay out any swap size here

        JensenBuybackBurnHarness jbb = new JensenBuybackBurnHarness(1e6, 75, 100, 500, 2e8, 1800);
        address usdc = address(jbb.USDC());
        deal(usdc, address(jbb), 11e6); // matches the real $11 test amount

        try jbb.swapAndBurn() {
            console.log("SUCCEEDED");
        } catch Error(string memory reason) {
            console.log("REVERT (Error string):", reason);
        } catch Panic(uint256 code) {
            console.log("REVERT (Panic):", code);
        } catch (bytes memory lowLevelData) {
            console.log("REVERT (raw bytes), length:", lowLevelData.length);
            console.logBytes(lowLevelData);
        }
    }
}
