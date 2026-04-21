// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/EscrowV1.sol";

/**
 * @title Deploy
 * @notice Deploys EscrowV1 using environment variables.
 *         Chain-agnostic: works against Anvil, Sepolia, or mainnet
 *         depending on --rpc-url passed at invocation.
 *
 * Required env vars:
 *   PRIVATE_KEY          - deployer private key (hex, 0x-prefixed)
 *   USDC_BASE_SEPOLIA    - USDC token address
 *   ARBITER_ADDRESS      - arbiter address
 *   FEE_RECIPIENT        - fee recipient address
 *
 * Usage (dry-run, no broadcast):
 *   forge script contracts/script/Deploy.s.sol --rpc-url $RPC_URL
 *
 * Usage (live deploy):
 *   forge script contracts/script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerKey  = vm.envUint("PRIVATE_KEY");
        address usdcAddress  = vm.envAddress("USDC_BASE_SEPOLIA");
        address arbiter      = vm.envAddress("ARBITER_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");

        console2.log("=== EscrowV1 Deploy ===");
        console2.log("USDC:          ", usdcAddress);
        console2.log("Arbiter:       ", arbiter);
        console2.log("FeeRecipient:  ", feeRecipient);
        console2.log("Chain ID:      ", block.chainid);

        vm.startBroadcast(deployerKey);

        EscrowV1 escrow = new EscrowV1(usdcAddress, arbiter, feeRecipient);

        vm.stopBroadcast();

        console2.log("EscrowV1 deployed at:", address(escrow));
        console2.log("releaseFeeBps:", escrow.releaseFeeBps());
        console2.log("resolveFeeBps:", escrow.resolveFeeBps());
    }
}
