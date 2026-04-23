// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/ReputationV1.sol";

/**
 * @title DeployReputationV1
 * @notice Deploys ReputationV1 pointing at an existing EscrowV1 deployment.
 *         Ownership is transferred to INITIAL_OWNER (intended to be the
 *         arbiter multisig once it exists; until then, a hardware-wallet
 *         EOA is acceptable for Sepolia staging).
 *
 * Required env vars:
 *   PRIVATE_KEY      - deployer private key (hex, 0x-prefixed)
 *   INITIAL_OWNER    - address that will own the contract post-deploy
 *   ESCROW_ADDRESS   - existing EscrowV1 address to authorize as minter
 *
 * Optional env vars:
 *   EXPLORER_BASE    - Basescan URL prefix for tokenURI linking.
 *                      Defaults to Sepolia. Override for mainnet deploys.
 *
 * Usage (dry-run):
 *   forge script contracts/script/DeployReputationV1.s.sol \
 *       --rpc-url $RPC_URL
 *
 * Usage (live deploy to Sepolia):
 *   forge script contracts/script/DeployReputationV1.s.sol \
 *       --rpc-url $SEPOLIA_RPC \
 *       --broadcast \
 *       --verify \
 *       --etherscan-api-key $BASESCAN_API_KEY
 *
 * NOTE: Do not deploy until the three gates listed in Dev Log #021 clear:
 *   1. Full EscrowV1 audit
 *   2. Decision on in-contract mint hook vs off-chain relayer
 *   3. Multisig arbiter online (receipt contract owner should be the Safe)
 */
contract DeployReputationV1 is Script {
    function run() external returns (ReputationV1 deployed) {
        uint256 deployerKey  = vm.envUint("PRIVATE_KEY");
        address initialOwner = vm.envAddress("INITIAL_OWNER");
        address escrowAddr   = vm.envAddress("ESCROW_ADDRESS");

        string memory explorerBase;
        try vm.envString("EXPLORER_BASE") returns (string memory v) {
            explorerBase = v;
        } catch {
            explorerBase = "https://sepolia.basescan.org/address/";
        }

        console2.log("=== ReputationV1 Deploy ===");
        console2.log("Initial owner: ", initialOwner);
        console2.log("Escrow:        ", escrowAddr);
        console2.log("Chain ID:      ", block.chainid);

        vm.startBroadcast(deployerKey);
        deployed = new ReputationV1(initialOwner, escrowAddr);

        // Only override explorer base if caller provided one (non-default).
        if (bytes(explorerBase).length > 0 &&
            keccak256(bytes(explorerBase)) !=
            keccak256(bytes("https://sepolia.basescan.org/address/")))
        {
            deployed.setExplorerBase(explorerBase);
        }
        vm.stopBroadcast();

        console2.log("Deployed at:   ", address(deployed));
        console2.log("Owner:         ", deployed.owner());
        console2.log("Escrow:        ", deployed.escrowContract());
    }
}
