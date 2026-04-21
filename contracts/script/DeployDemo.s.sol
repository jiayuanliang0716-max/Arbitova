// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/EscrowV1.sol";

contract MockUsdc {
    string public name     = "USD Coin";
    string public symbol   = "USDC";
    uint8  public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply   += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from]             >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        return true;
    }
}

contract DeployDemo is Script {
    address constant DEPLOYER  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant BUYER     = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant ARBITER   = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address constant FEE_RECIP = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;

    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        vm.startBroadcast(DEPLOYER_KEY);
        MockUsdc usdc   = new MockUsdc();
        EscrowV1 escrow = new EscrowV1(address(usdc), ARBITER, FEE_RECIP);
        usdc.mint(BUYER, 10_000_000); // 10 USDC
        vm.stopBroadcast();

        console2.log("USDC_ADDRESS=", address(usdc));
        console2.log("ESCROW_ADDRESS=", address(escrow));
        console2.log("BUYER_USDC_BAL=", usdc.balanceOf(BUYER));
    }
}
