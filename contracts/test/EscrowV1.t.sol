// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/EscrowV1.sol";

// ---------------------------------------------------------------------------
// MockUsdc — standard 6-decimal ERC20 used throughout most tests
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
        totalSupply    += amount;
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
        require(balanceOf[from]          >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        return true;
    }
}

// ---------------------------------------------------------------------------
// MaliciousUsdc — re-enters EscrowV1.confirmDelivery on the outbound transfer
// to the seller, verifying that ReentrancyGuard stops the second call.
// ---------------------------------------------------------------------------
contract MaliciousUsdc {
    string public name     = "Evil USDC";
    string public symbol   = "EUSDC";
    uint8  public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public totalSupply;

    address public escrow;
    uint256 public targetId;
    bool    public attacking;

    function setEscrow(address _escrow, uint256 _id) external {
        escrow   = _escrow;
        targetId = _id;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply    += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        // Trigger re-entry only once to avoid infinite loop
        if (!attacking && escrow != address(0) && to != address(0)) {
            attacking = true;
            // Attempt to re-enter confirmDelivery — should revert due to nonReentrant
            try EscrowV1(escrow).confirmDelivery(targetId) {} catch {}
            attacking = false;
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
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
// Main test suite
// ---------------------------------------------------------------------------
contract EscrowV1Test is Test {

    // Common constants
    uint64 constant DELIVERY_WIN = 7 days;    // 604800 seconds
    uint64 constant REVIEW_WIN   = 3 days;    // 259200 seconds
    uint256 constant AMOUNT      = 1_000e6;   // 1000 USDC

    // Actors
    address owner    = makeAddr("owner");
    address buyer    = makeAddr("buyer");
    address seller   = makeAddr("seller");
    address arbiter  = makeAddr("arbiter");
    address feeRecip = makeAddr("feeRecipient");
    address stranger = makeAddr("stranger");

    MockUsdc   usdc;
    EscrowV1   escrow;

    // ---------------------------------------------------------------------------
    // Setup helpers
    // ---------------------------------------------------------------------------

    function setUp() public {
        vm.startPrank(owner);
        usdc   = new MockUsdc();
        escrow = new EscrowV1(address(usdc), arbiter, feeRecip);
        vm.stopPrank();

        // Fund buyer and approve escrow
        usdc.mint(buyer, 10_000e6);
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    /// @dev Creates a standard escrow and returns its ID.
    function _create() internal returns (uint256 id) {
        vm.prank(buyer);
        id = escrow.createEscrow(seller, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "ipfs://criteria");
    }

    /// @dev Creates and marks delivered; returns ID.
    function _createAndDeliver() internal returns (uint256 id) {
        id = _create();
        vm.prank(seller);
        escrow.markDelivered(id, keccak256("payload"));
    }

    /// @dev Creates, delivers, and disputes; returns ID.
    function _createDeliverDispute() internal returns (uint256 id) {
        id = _createAndDeliver();
        vm.prank(buyer);
        escrow.dispute(id, "not satisfied");
    }

    // ===========================================================================
    // HAPPY PATH TESTS
    // ===========================================================================

    function test_createEscrow_locksUsdc() public {
        uint256 beforeBuyer   = usdc.balanceOf(buyer);
        uint256 beforeEscrow  = usdc.balanceOf(address(escrow));

        uint256 id = _create();

        assertEq(usdc.balanceOf(buyer),           beforeBuyer  - AMOUNT, "buyer debited");
        assertEq(usdc.balanceOf(address(escrow)), beforeEscrow + AMOUNT, "escrow credited");

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.buyer,  buyer);
        assertEq(e.seller, seller);
        assertEq(e.amount, AMOUNT);
        assertEq(uint8(e.state), uint8(EscrowV1.State.CREATED));
        assertEq(id, 1, "first escrow ID is 1");
    }

    function test_markDelivered_setsReviewDeadline() public {
        uint256 id = _create();

        uint256 ts = block.timestamp;
        vm.prank(seller);
        escrow.markDelivered(id, keccak256("payload"));

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.DELIVERED));
        assertEq(e.deliveryHash, keccak256("payload"));
        assertEq(e.reviewDeadline, ts + REVIEW_WIN, "reviewDeadline = markDelivered ts + reviewWindowSec");
    }

    function test_confirmDelivery_transfersToSellerMinusFee() public {
        uint256 id = _createAndDeliver();

        uint256 beforeSeller  = usdc.balanceOf(seller);
        uint256 beforeFeeRecip = usdc.balanceOf(feeRecip);

        vm.prank(buyer);
        escrow.confirmDelivery(id);

        uint256 expectedFee    = (AMOUNT * 50) / 10_000;   // 0.5%
        uint256 expectedSeller = AMOUNT - expectedFee;

        assertEq(usdc.balanceOf(seller),   beforeSeller  + expectedSeller, "seller receives amount minus fee");
        assertEq(usdc.balanceOf(feeRecip), beforeFeeRecip + expectedFee,   "fee recipient receives fee");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.RELEASED));
    }

    function test_resolve_splitsPerBps() public {
        uint256 id = _createDeliverDispute();

        uint256 beforeBuyer  = usdc.balanceOf(buyer);
        uint256 beforeSeller = usdc.balanceOf(seller);

        // 60% buyer, 40% seller
        vm.prank(arbiter);
        escrow.resolve(id, 6000, 4000, keccak256("verdict"));

        uint256 buyerGross  = (AMOUNT * 6000) / 10_000;
        uint256 sellerGross = (AMOUNT * 4000) / 10_000;
        uint256 buyerFee    = (buyerGross  * 200) / 10_000;
        uint256 sellerFee   = (sellerGross * 200) / 10_000;

        assertEq(usdc.balanceOf(buyer),  beforeBuyer  + buyerGross  - buyerFee,  "buyer net");
        assertEq(usdc.balanceOf(seller), beforeSeller + sellerGross - sellerFee, "seller net");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_cancelIfNotDelivered_refundsBuyer() public {
        uint256 id = _create();

        vm.warp(block.timestamp + DELIVERY_WIN + 1);

        uint256 beforeBuyer = usdc.balanceOf(buyer);

        vm.prank(buyer);
        escrow.cancelIfNotDelivered(id);

        assertEq(usdc.balanceOf(buyer), beforeBuyer + AMOUNT, "buyer fully refunded");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.CANCELLED));
    }

    function test_escalateIfExpired_movesToDisputed() public {
        uint256 id = _createAndDeliver();

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        vm.warp(e.reviewDeadline + 1);

        escrow.escalateIfExpired(id); // callable by anyone

        e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.DISPUTED));
    }

    // ===========================================================================
    // REVERT TESTS — createEscrow
    // ===========================================================================

    function test_revert_createEscrow_sellerZero() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.SellerIsZero.selector);
        escrow.createEscrow(address(0), AMOUNT, DELIVERY_WIN, REVIEW_WIN, "");
    }

    function test_revert_createEscrow_sellerIsBuyer() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.SellerIsBuyer.selector);
        escrow.createEscrow(buyer, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "");
    }

    function test_revert_createEscrow_amountZero() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.AmountIsZero.selector);
        escrow.createEscrow(seller, 0, DELIVERY_WIN, REVIEW_WIN, "");
    }

    function test_revert_createEscrow_deliveryWindowTooShort() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.DeliveryWindowTooShort.selector);
        escrow.createEscrow(seller, AMOUNT, 3599, REVIEW_WIN, "");
    }

    function test_revert_createEscrow_deliveryWindowTooLong() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.DeliveryWindowTooLong.selector);
        escrow.createEscrow(seller, AMOUNT, 2_592_001, REVIEW_WIN, "");
    }

    function test_revert_createEscrow_reviewWindowTooShort() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.ReviewWindowTooShort.selector);
        escrow.createEscrow(seller, AMOUNT, DELIVERY_WIN, 3599, "");
    }

    function test_revert_createEscrow_reviewWindowTooLong() public {
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.ReviewWindowTooLong.selector);
        escrow.createEscrow(seller, AMOUNT, DELIVERY_WIN, 2_592_001, "");
    }

    function test_revert_createEscrow_transferFails() public {
        // Buyer has no approval for this separate escrow instance
        vm.startPrank(owner);
        EscrowV1 escrow2 = new EscrowV1(address(usdc), arbiter, feeRecip);
        vm.stopPrank();

        // buyer hasn't approved escrow2
        vm.prank(buyer);
        vm.expectRevert(); // SafeERC20 wraps the revert
        escrow2.createEscrow(seller, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "");
    }

    // ===========================================================================
    // REVERT TESTS — markDelivered
    // ===========================================================================

    function test_revert_markDelivered_notSeller() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(EscrowV1.NotSeller.selector);
        escrow.markDelivered(id, keccak256("x"));
    }

    function test_revert_markDelivered_wrongState() public {
        uint256 id = _createAndDeliver(); // now DELIVERED
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.DELIVERED));
        escrow.markDelivered(id, keccak256("x"));
    }

    function test_revert_markDelivered_deadlinePassed() public {
        uint256 id = _create();
        vm.warp(block.timestamp + DELIVERY_WIN + 1);
        vm.prank(seller);
        vm.expectRevert(EscrowV1.DeliveryDeadlinePassed.selector);
        escrow.markDelivered(id, keccak256("x"));
    }

    // ===========================================================================
    // REVERT TESTS — confirmDelivery
    // ===========================================================================

    function test_revert_confirmDelivery_notBuyer() public {
        uint256 id = _createAndDeliver();
        vm.prank(stranger);
        vm.expectRevert(EscrowV1.NotBuyer.selector);
        escrow.confirmDelivery(id);
    }

    function test_revert_confirmDelivery_wrongState() public {
        uint256 id = _create(); // CREATED, not DELIVERED
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.CREATED));
        escrow.confirmDelivery(id);
    }

    // ===========================================================================
    // REVERT TESTS — dispute
    // ===========================================================================

    function test_revert_dispute_notBuyerOrSeller() public {
        uint256 id = _create();
        vm.prank(stranger);
        vm.expectRevert(EscrowV1.NotBuyerOrSeller.selector);
        escrow.dispute(id, "huh");
    }

    function test_revert_dispute_wrongState_released() public {
        uint256 id = _createAndDeliver();
        vm.prank(buyer);
        escrow.confirmDelivery(id);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.RELEASED));
        escrow.dispute(id, "too late");
    }

    // ===========================================================================
    // REVERT TESTS — escalateIfExpired
    // ===========================================================================

    function test_revert_escalateIfExpired_wrongState() public {
        uint256 id = _create(); // CREATED
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.CREATED));
        escrow.escalateIfExpired(id);
    }

    function test_revert_escalateIfExpired_notExpired() public {
        uint256 id = _createAndDeliver();
        vm.expectRevert(EscrowV1.ReviewDeadlineNotPassed.selector);
        escrow.escalateIfExpired(id);
    }

    // ===========================================================================
    // REVERT TESTS — cancelIfNotDelivered
    // ===========================================================================

    function test_revert_cancelIfNotDelivered_notBuyer() public {
        uint256 id = _create();
        vm.warp(block.timestamp + DELIVERY_WIN + 1);
        vm.prank(stranger);
        vm.expectRevert(EscrowV1.NotBuyer.selector);
        escrow.cancelIfNotDelivered(id);
    }

    function test_revert_cancelIfNotDelivered_wrongState() public {
        uint256 id = _createAndDeliver(); // DELIVERED
        vm.warp(block.timestamp + DELIVERY_WIN + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.DELIVERED));
        escrow.cancelIfNotDelivered(id);
    }

    function test_revert_cancelIfNotDelivered_deadlineNotPassed() public {
        uint256 id = _create();
        vm.prank(buyer);
        vm.expectRevert(EscrowV1.DeliveryDeadlineNotPassed.selector);
        escrow.cancelIfNotDelivered(id);
    }

    // ===========================================================================
    // REVERT TESTS — resolve
    // ===========================================================================

    function test_revert_resolve_notArbiter() public {
        uint256 id = _createDeliverDispute();
        vm.prank(stranger);
        vm.expectRevert(EscrowV1.NotArbiter.selector);
        escrow.resolve(id, 5000, 5000, bytes32(0));
    }

    function test_revert_resolve_wrongState() public {
        uint256 id = _create(); // CREATED
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.CREATED));
        escrow.resolve(id, 5000, 5000, bytes32(0));
    }

    function test_revert_resolve_bpsSumNot10000() public {
        uint256 id = _createDeliverDispute();
        vm.prank(arbiter);
        vm.expectRevert(EscrowV1.BpsSumNot10000.selector);
        escrow.resolve(id, 5000, 4999, bytes32(0));
    }

    // ===========================================================================
    // EDGE CASE TESTS
    // ===========================================================================

    function test_confirmDelivery_cannotDoubleSpend() public {
        uint256 id = _createAndDeliver();

        vm.prank(buyer);
        escrow.confirmDelivery(id);

        // Second confirm must revert — state is now RELEASED
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EscrowV1.WrongState.selector, EscrowV1.State.RELEASED));
        escrow.confirmDelivery(id);
    }

    function test_reentrancy_confirmDelivery() public {
        // Deploy malicious token
        MaliciousUsdc evil = new MaliciousUsdc();

        // Deploy fresh escrow backed by malicious token
        vm.prank(owner);
        EscrowV1 evilEscrow = new EscrowV1(address(evil), arbiter, feeRecip);

        // Mint and approve
        evil.mint(buyer, AMOUNT);
        vm.prank(buyer);
        evil.approve(address(evilEscrow), AMOUNT);

        // Create escrow
        vm.prank(buyer);
        uint256 id = evilEscrow.createEscrow(seller, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "");

        // Mark delivered
        vm.prank(seller);
        evilEscrow.markDelivered(id, keccak256("payload"));

        // Point malicious token at the target
        evil.setEscrow(address(evilEscrow), id);

        // confirmDelivery should succeed (ReentrancyGuard blocks the nested call,
        // the nested call's revert is caught by the try/catch in MaliciousUsdc.transfer)
        vm.prank(buyer);
        evilEscrow.confirmDelivery(id);

        // Verify the escrow state is RELEASED (not drained twice)
        EscrowV1.Escrow memory e = evilEscrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.RELEASED));
        // Escrow contract balance should be 0 (all transferred out once)
        assertEq(evil.balanceOf(address(evilEscrow)), 0, "no double-drain via reentrancy");
    }

    function test_resolve_with100_0_bps() public {
        uint256 id = _createDeliverDispute();

        uint256 beforeBuyer = usdc.balanceOf(buyer);

        vm.prank(arbiter);
        escrow.resolve(id, 10000, 0, keccak256("verdict"));

        uint256 buyerGross = AMOUNT;
        uint256 buyerFee   = (buyerGross * 200) / 10_000;

        assertEq(usdc.balanceOf(buyer),  beforeBuyer + buyerGross - buyerFee, "100% to buyer minus fee");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_resolve_with0_100_bps() public {
        uint256 id = _createDeliverDispute();

        uint256 beforeSeller = usdc.balanceOf(seller);

        vm.prank(arbiter);
        escrow.resolve(id, 0, 10000, keccak256("verdict"));

        uint256 sellerGross = AMOUNT;
        uint256 sellerFee   = (sellerGross * 200) / 10_000;

        assertEq(usdc.balanceOf(seller), beforeSeller + sellerGross - sellerFee, "100% to seller minus fee");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained");
    }

    function test_escalateIfExpired_callableByAnyone() public {
        uint256 id = _createAndDeliver();

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        vm.warp(e.reviewDeadline + 1);

        // Stranger (not buyer or seller) escalates
        vm.prank(stranger);
        escrow.escalateIfExpired(id);

        e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.DISPUTED), "escalated by stranger");
    }

    function test_fee_zeroBps() public {
        vm.prank(owner);
        escrow.setReleaseFeeBps(0);

        uint256 id = _createAndDeliver();

        uint256 beforeSeller  = usdc.balanceOf(seller);
        uint256 beforeFeeRecip = usdc.balanceOf(feeRecip);

        vm.prank(buyer);
        escrow.confirmDelivery(id);

        assertEq(usdc.balanceOf(seller),   beforeSeller + AMOUNT, "seller receives full amount when fee=0");
        assertEq(usdc.balanceOf(feeRecip), beforeFeeRecip,        "fee recipient receives nothing");
    }

    // ===========================================================================
    // DISPUTE VARIATIONS
    // ===========================================================================

    function test_dispute_inCreatedState_byBuyer() public {
        uint256 id = _create();
        vm.prank(buyer);
        escrow.dispute(id, "no delivery attempt");

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.DISPUTED));
    }

    function test_dispute_inDeliveredState_bySeller() public {
        uint256 id = _createAndDeliver();
        vm.prank(seller);
        escrow.dispute(id, "buyer ignoring delivery");

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.DISPUTED));
    }

    // ===========================================================================
    // OWNER CONFIGURATION TESTS
    // ===========================================================================

    function test_setArbiter_emitsEvent() public {
        address newArb = makeAddr("newArbiter");
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit EscrowV1.ArbiterChanged(arbiter, newArb);
        escrow.setArbiter(newArb);
        assertEq(escrow.arbiter(), newArb);
    }

    function test_setFeeRecipient_emitsEvent() public {
        address newFee = makeAddr("newFee");
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit EscrowV1.FeeRecipientChanged(feeRecip, newFee);
        escrow.setFeeRecipient(newFee);
        assertEq(escrow.feeRecipient(), newFee);
    }

    function test_setReleaseFeeBps_cappedAt200() public {
        vm.prank(owner);
        vm.expectRevert(EscrowV1.FeeBpsTooHigh.selector);
        escrow.setReleaseFeeBps(201);
    }

    function test_setResolveFeeBps_cappedAt500() public {
        vm.prank(owner);
        vm.expectRevert(EscrowV1.FeeBpsTooHigh.selector);
        escrow.setResolveFeeBps(501);
    }

    function test_setReleaseFeeBps_success() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit EscrowV1.ReleaseFeeChanged(50, 100);
        escrow.setReleaseFeeBps(100);
        assertEq(escrow.releaseFeeBps(), 100);
    }

    function test_setResolveFeeBps_success() public {
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit EscrowV1.ResolveFeeChanged(200, 300);
        escrow.setResolveFeeBps(300);
        assertEq(escrow.resolveFeeBps(), 300);
    }

    function test_nextEscrowId_incrementsCorrectly() public {
        uint256 id1 = _create();

        usdc.mint(buyer, AMOUNT);
        vm.prank(buyer);
        usdc.approve(address(escrow), AMOUNT);
        vm.prank(buyer);
        uint256 id2 = escrow.createEscrow(seller, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "");

        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    // ===========================================================================
    // FUZZ TESTS
    // ===========================================================================

    function testFuzz_createEscrow_anyValidAmount(
        uint128 amount,
        uint32  deliverySec,
        uint32  reviewSec
    ) public {
        vm.assume(amount      > 0);
        vm.assume(deliverySec >= 3_600   && deliverySec <= 2_592_000);
        vm.assume(reviewSec   >= 3_600   && reviewSec   <= 2_592_000);

        usdc.mint(buyer, amount);
        vm.prank(buyer);
        usdc.approve(address(escrow), amount);

        vm.prank(buyer);
        uint256 id = escrow.createEscrow(seller, amount, deliverySec, reviewSec, "fuzz");

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(e.amount, amount);
        assertEq(uint8(e.state), uint8(EscrowV1.State.CREATED));
    }

    function testFuzz_resolve_bpsSumMustBe10000(uint16 buyerBps) public {
        // Constrain buyerBps so that sellerBps = 10000 - buyerBps fits in uint16 (no underflow).
        vm.assume(buyerBps <= 10_000);

        uint256 id = _createDeliverDispute();

        uint16 sellerBps = uint16(10_000 - uint256(buyerBps));

        vm.prank(arbiter);
        // Should always succeed when sum == 10000
        escrow.resolve(id, buyerBps, sellerBps, keccak256("fuzz-verdict"));

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.RESOLVED));
    }

    function testFuzz_resolve_invalidBpsReverts(uint16 buyerBps, uint16 sellerBps) public {
        vm.assume(uint32(buyerBps) + uint32(sellerBps) != 10_000);

        uint256 id = _createDeliverDispute();

        vm.prank(arbiter);
        vm.expectRevert(EscrowV1.BpsSumNot10000.selector);
        escrow.resolve(id, buyerBps, sellerBps, bytes32(0));
    }

    // ===========================================================================
    // PAUSABLE TESTS (M-7)
    // ===========================================================================

    function test_pause_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        escrow.pause();
    }

    function test_paused_blocksCreateEscrow() public {
        vm.prank(owner);
        escrow.pause();

        vm.prank(buyer);
        vm.expectRevert();
        escrow.createEscrow(seller, AMOUNT, DELIVERY_WIN, REVIEW_WIN, "");
    }

    function test_paused_blocksDispute() public {
        uint256 id = _createAndDeliver();

        vm.prank(owner);
        escrow.pause();

        vm.prank(buyer);
        vm.expectRevert();
        escrow.dispute(id, "blocked");
    }

    function test_paused_blocksResolve() public {
        uint256 id = _createDeliverDispute();

        vm.prank(owner);
        escrow.pause();

        vm.prank(arbiter);
        vm.expectRevert();
        escrow.resolve(id, 5_000, 5_000, bytes32(0));
    }

    // Exit paths MUST remain open even when paused —
    // paused must never trap user funds.

    function test_paused_confirmDelivery_stillWorks() public {
        uint256 id = _createAndDeliver();

        vm.prank(owner);
        escrow.pause();

        vm.prank(buyer);
        escrow.confirmDelivery(id);

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.RELEASED));
    }

    function test_paused_cancelIfNotDelivered_stillWorks() public {
        uint256 id = _create();

        vm.prank(owner);
        escrow.pause();

        vm.warp(block.timestamp + DELIVERY_WIN + 1);

        vm.prank(buyer);
        escrow.cancelIfNotDelivered(id);

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.CANCELLED));
    }

    function test_paused_escalateIfExpired_stillWorks() public {
        uint256 id = _createAndDeliver();

        vm.prank(owner);
        escrow.pause();

        vm.warp(block.timestamp + REVIEW_WIN + 1);

        vm.prank(stranger);
        escrow.escalateIfExpired(id);

        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.DISPUTED));
    }

    function test_unpause_restoresOperations() public {
        vm.prank(owner);
        escrow.pause();

        vm.prank(owner);
        escrow.unpause();

        uint256 id = _create();
        EscrowV1.Escrow memory e = escrow.getEscrow(id);
        assertEq(uint8(e.state), uint8(EscrowV1.State.CREATED));
    }
}
