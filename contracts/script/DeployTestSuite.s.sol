// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../src/EscrowV1.sol";
import "../src/MockUSDC.sol";

contract DeployTestSuite is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);

        MockUSDC usdc = new MockUSDC();
        EscrowV1 escrow = new EscrowV1(address(usdc), deployer, deployer);

        vm.stopBroadcast();

        console.log("=== Test Suite Deployed ===");
        console.log("MockUSDC:", address(usdc));
        console.log("EscrowV1 (test):", address(escrow));
        console.log("Arbiter/FeeRecipient:", deployer);
    }
}
