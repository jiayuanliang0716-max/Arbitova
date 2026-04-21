// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "forge-std/console2.sol";
import "../src/EscrowV1.sol";

// ---------------------------------------------------------------------------
// MockUsdc — 6-decimal ERC20 with unrestricted mint for local testing
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// LocalE2E — full end-to-end test against a live Anvil node
// ---------------------------------------------------------------------------
contract LocalE2E is Script {

    // Anvil default accounts (deterministic from mnemonic "test test ... junk")
    address constant DEPLOYER  = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address constant BUYER     = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address constant SELLER    = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address constant BUYER2    = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address constant ARBITER   = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;
    address constant FEE_RECIP = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc;

    uint256 constant DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant BUYER_KEY    = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant SELLER_KEY   = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant BUYER2_KEY   = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    uint256 constant ARBITER_KEY  = 0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a;

    uint256 constant AMOUNT = 1_000e6; // 1000 USDC
    uint64  constant DELIVERY_WIN = 7 days;
    uint64  constant REVIEW_WIN   = 3 days;

    MockUsdc usdc;
    EscrowV1 escrow;

    function run() external {
        // -----------------------------------------------------------------------
        // Bootstrap: deploy MockUsdc and EscrowV1 as deployer
        // -----------------------------------------------------------------------
        vm.startBroadcast(DEPLOYER_KEY);
        usdc   = new MockUsdc();
        escrow = new EscrowV1(address(usdc), ARBITER, FEE_RECIP);
        vm.stopBroadcast();

        console2.log("=== LocalE2E: contracts deployed ===");
        console2.log("MockUsdc  :", address(usdc));
        console2.log("EscrowV1  :", address(escrow));

        // Mint 1000 USDC to each test actor (deployer can call mint freely)
        vm.startBroadcast(DEPLOYER_KEY);
        usdc.mint(BUYER,  1_000e6);
        usdc.mint(SELLER, 1_000e6);
        usdc.mint(BUYER2, 1_000e6);
        vm.stopBroadcast();

        console2.log("--- Minted 1000 USDC to BUYER, SELLER, BUYER2 ---");

        _flow1_happyPath();
        _flow2_disputePath();
        // Flow 3 (timeout escalation) is executed via cast + Anvil time RPC in run_e2e.sh
        // because vm.warp cannot be broadcast to a live node.

        console2.log("=== FLOWS 1+2 COMPLETE (Flow3 run separately via cast) ===");
    }

    // =========================================================================
    // Flow 1 — Happy path
    // =========================================================================
    function _flow1_happyPath() internal {
        console2.log("\n=== FLOW 1: Happy Path ===");

        uint256 buyerBefore     = usdc.balanceOf(BUYER);
        uint256 sellerBefore    = usdc.balanceOf(SELLER);
        uint256 feeRecipBefore  = usdc.balanceOf(FEE_RECIP);
        uint256 escrowBefore    = usdc.balanceOf(address(escrow));

        console2.log("BEFORE:");
        console2.log("  BUYER bal    :", buyerBefore);
        console2.log("  SELLER bal   :", sellerBefore);
        console2.log("  FEE_RECIP bal:", feeRecipBefore);
        console2.log("  ESCROW bal   :", escrowBefore);

        // Step 1: buyer approves
        vm.startBroadcast(BUYER_KEY);
        usdc.approve(address(escrow), AMOUNT);
        vm.stopBroadcast();
        console2.log("Step 1: buyer approved escrow");

        // Step 2: buyer creates escrow
        vm.startBroadcast(BUYER_KEY);
        uint256 id = escrow.createEscrow(SELLER, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "ipfs://flow1-criteria");
        vm.stopBroadcast();
        console2.log("Step 2: escrow created, id =", id);

        // Step 3: seller marks delivered
        vm.startBroadcast(SELLER_KEY);
        escrow.markDelivered(id, keccak256("flow1-payload"));
        vm.stopBroadcast();
        console2.log("Step 3: seller marked delivered");

        // Step 4: buyer confirms delivery
        vm.startBroadcast(BUYER_KEY);
        escrow.confirmDelivery(id);
        vm.stopBroadcast();
        console2.log("Step 4: buyer confirmed delivery");

        uint256 buyerAfter    = usdc.balanceOf(BUYER);
        uint256 sellerAfter   = usdc.balanceOf(SELLER);
        uint256 feeRecipAfter = usdc.balanceOf(FEE_RECIP);
        uint256 escrowAfter   = usdc.balanceOf(address(escrow));

        console2.log("AFTER:");
        console2.log("  BUYER bal    :", buyerAfter);
        console2.log("  SELLER bal   :", sellerAfter);
        console2.log("  FEE_RECIP bal:", feeRecipAfter);
        console2.log("  ESCROW bal   :", escrowAfter);

        // Expected math:
        //   fee      = AMOUNT * 50 / 10000 = 1000e6 * 50 / 10000 = 5000 (5 USDC)
        //   toSeller = AMOUNT - fee = 1000e6 - 5000 = 995000000 (995 USDC)
        uint256 expectedFee      = (AMOUNT * 50) / 10_000;
        uint256 expectedToSeller = AMOUNT - expectedFee;

        console2.log("EXPECTED fee      :", expectedFee);
        console2.log("EXPECTED toSeller :", expectedToSeller);

        bool sellerOk   = (sellerAfter   == sellerBefore + expectedToSeller);
        bool feeOk      = (feeRecipAfter == feeRecipBefore + expectedFee);
        bool escrowOk   = (escrowAfter   == 0);
        bool stateOk    = (uint8(escrow.getEscrow(id).state) == uint8(EscrowV1.State.RELEASED));

        console2.log("CHECKS:");
        console2.log("  seller net correct :", sellerOk   ? 1 : 0);
        console2.log("  fee correct        :", feeOk      ? 1 : 0);
        console2.log("  escrow drained     :", escrowOk   ? 1 : 0);
        console2.log("  state == RELEASED  :", stateOk    ? 1 : 0);

        require(sellerOk,  "FLOW1 FAIL: seller balance wrong");
        require(feeOk,     "FLOW1 FAIL: fee recipient balance wrong");
        require(escrowOk,  "FLOW1 FAIL: escrow not drained");
        require(stateOk,   "FLOW1 FAIL: state not RELEASED");

        console2.log("FLOW 1 RESULT: PASS");
    }

    // =========================================================================
    // Flow 2 — Dispute path (arbiter resolves 70/30)
    // =========================================================================
    function _flow2_disputePath() internal {
        console2.log("\n=== FLOW 2: Dispute Path (70% buyer / 30% seller) ===");

        // Mint fresh 1000 USDC to BUYER2 for this flow
        vm.startBroadcast(DEPLOYER_KEY);
        usdc.mint(BUYER2, 1_000e6);
        vm.stopBroadcast();

        _flow2_execute();
    }

    function _flow2_execute() internal {
        uint256 buyer2Before   = usdc.balanceOf(BUYER2);
        uint256 sellerBefore   = usdc.balanceOf(SELLER);
        uint256 feeRecipBefore = usdc.balanceOf(FEE_RECIP);

        console2.log("BEFORE:");
        console2.log("  BUYER2 bal   :", buyer2Before);
        console2.log("  SELLER bal   :", sellerBefore);
        console2.log("  FEE_RECIP bal:", feeRecipBefore);
        console2.log("  ESCROW bal   :", usdc.balanceOf(address(escrow)));

        // buyer2 approves and creates
        vm.startBroadcast(BUYER2_KEY);
        usdc.approve(address(escrow), AMOUNT);
        uint256 id = escrow.createEscrow(SELLER, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "ipfs://flow2-criteria");
        vm.stopBroadcast();
        console2.log("Step 1+2: buyer2 created escrow, id =", id);

        // seller marks delivered
        vm.startBroadcast(SELLER_KEY);
        escrow.markDelivered(id, keccak256("flow2-payload"));
        vm.stopBroadcast();
        console2.log("Step 3: seller marked delivered");

        // buyer2 disputes
        vm.startBroadcast(BUYER2_KEY);
        escrow.dispute(id, "delivery does not meet criteria");
        vm.stopBroadcast();
        console2.log("Step 4: buyer2 opened dispute");

        // arbiter resolves 7000 / 3000
        vm.startBroadcast(ARBITER_KEY);
        escrow.resolve(id, 7000, 3000, keccak256("flow2-verdict"));
        vm.stopBroadcast();
        console2.log("Step 5: arbiter resolved 7000 buyer / 3000 seller");

        _flow2_verify(id, buyer2Before, sellerBefore, feeRecipBefore);
    }

    function _flow2_verify(
        uint256 id,
        uint256 buyer2Before,
        uint256 sellerBefore,
        uint256 feeRecipBefore
    ) internal view {
        // Split into two scopes to avoid stack-too-deep
        _flow2_logAfter();
        _flow2_assert(id, buyer2Before, sellerBefore, feeRecipBefore);
    }

    function _flow2_logAfter() internal view {
        console2.log("AFTER:");
        console2.log("  BUYER2 bal   :", usdc.balanceOf(BUYER2));
        console2.log("  SELLER bal   :", usdc.balanceOf(SELLER));
        console2.log("  FEE_RECIP bal:", usdc.balanceOf(FEE_RECIP));
        console2.log("  ESCROW bal   :", usdc.balanceOf(address(escrow)));
        // Expected: buyerGross=700e6, sellerGross=300e6, buyerFee=14e6, sellerFee=6e6
        // toBuyer=686e6, toSeller=294e6, totalFee=20e6
        console2.log("EXPECTED toBuyer  : 686000000");
        console2.log("EXPECTED toSeller : 294000000");
        console2.log("EXPECTED totalFee : 20000000");
    }

    function _flow2_assert(
        uint256 id,
        uint256 buyer2Before,
        uint256 sellerBefore,
        uint256 feeRecipBefore
    ) internal view {
        // toBuyer  = 700e6 - 14e6 = 686e6
        // toSeller = 300e6 - 6e6  = 294e6
        // totalFee = 14e6 + 6e6   = 20e6
        uint256 toBuyer  = 686_000_000;
        uint256 toSeller = 294_000_000;
        uint256 totalFee = 20_000_000;

        require(usdc.balanceOf(BUYER2)    == buyer2Before   - AMOUNT + toBuyer,  "FLOW2 FAIL: buyer2 balance wrong");
        require(usdc.balanceOf(SELLER)    == sellerBefore   + toSeller,          "FLOW2 FAIL: seller balance wrong");
        require(usdc.balanceOf(FEE_RECIP) == feeRecipBefore + totalFee,          "FLOW2 FAIL: fee recipient wrong");
        require(usdc.balanceOf(address(escrow)) == 0,                            "FLOW2 FAIL: escrow not drained");
        require(uint8(escrow.getEscrow(id).state) == uint8(EscrowV1.State.RESOLVED), "FLOW2 FAIL: state not RESOLVED");

        console2.log("CHECKS: buyer2 ok, seller ok, fee ok, escrow drained, state RESOLVED");
        console2.log("FLOW 2 RESULT: PASS");
    }

    // =========================================================================
    // Flow 3 — Timeout escalation
    // =========================================================================
    // Flow 3 is executed externally via cast + Anvil RPC time manipulation.
    // The setup (createEscrow + markDelivered) is done in Flow3Setup.s.sol.
    // The warp + escalateIfExpired is done via cast/curl in run_e2e.sh.
}
