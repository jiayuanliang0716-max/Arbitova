// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/EscrowV1.sol";

// Minimal MockUsdc interface for interacting with already-deployed mock
interface IMockUsdc {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/**
 * @title Flow3Setup
 * @notice Sets up Flow 3 escrow: mint → approve → createEscrow → markDelivered.
 *         After this script runs, use Anvil's evm_increaseTime + cast to
 *         call escalateIfExpired and verify state.
 *
 * Usage:
 *   forge script script/Flow3Setup.s.sol:Flow3Setup \
 *     --rpc-url http://localhost:8545 --broadcast \
 *     --sig "run(address,address)" <MOCK_USDC_ADDR> <ESCROW_V1_ADDR>
 */
contract Flow3Setup is Script {

    address constant DEPLOYER  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant BUYER     = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant SELLER    = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant BUYER_KEY    = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant SELLER_KEY   = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;

    uint256 constant AMOUNT       = 1_000e6;
    uint64  constant DELIVERY_WIN = 7 days;
    uint64  constant REVIEW_WIN   = 3 days;

    function run(address usdcAddr, address escrowAddr) external {
        IMockUsdc mockUsdc = IMockUsdc(usdcAddr);
        EscrowV1  escrow   = EscrowV1(escrowAddr);

        // Mint fresh USDC to BUYER
        vm.startBroadcast(DEPLOYER_KEY);
        mockUsdc.mint(BUYER, AMOUNT);
        vm.stopBroadcast();

        console2.log("\n=== FLOW 3: Timeout Escalation ===");
        console2.log("BEFORE:");
        console2.log("  BUYER bal  :", mockUsdc.balanceOf(BUYER));
        console2.log("  ESCROW bal :", mockUsdc.balanceOf(escrowAddr));

        // buyer approves + creates escrow
        vm.startBroadcast(BUYER_KEY);
        mockUsdc.approve(escrowAddr, AMOUNT);
        uint256 id = escrow.createEscrow(SELLER, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "ipfs://flow3-criteria");
        vm.stopBroadcast();
        console2.log("Step 1+2: buyer created escrow, id =", id);

        // seller marks delivered
        vm.startBroadcast(SELLER_KEY);
        escrow.markDelivered(id, keccak256("flow3-payload"));
        vm.stopBroadcast();

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        console2.log("Step 3: seller marked delivered");
        console2.log("reviewDeadline :", e.reviewDeadline);
        console2.log("ESCROW_ID      :", id);
        console2.log("REVIEW_DEADLINE:", e.reviewDeadline);

        // Output for shell: last two lines are parseable
        console2.log("FLOW3_ESCROW_ID=", id);
        console2.log("FLOW3_REVIEW_DEADLINE=", e.reviewDeadline);
    }
}
