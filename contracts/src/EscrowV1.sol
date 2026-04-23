// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// TODO (V1.1): implement createEscrowWithPermit to allow gasless USDC approval via EIP-2612 permit.

/**
 * @title EscrowV1
 * @notice Single-token (USDC) escrow with buyer / seller / arbiter flow.
 *
 * State machine:
 *
 *   CREATED ──markDelivered()──► DELIVERED ──confirmDelivery()──► RELEASED  (terminal)
 *      │                              │
 *      │                     escalateIfExpired()
 *      │                     or dispute()
 *      │                              │
 *      ├──dispute()──────────────────►┤
 *      │                              ▼
 *      │                          DISPUTED ──resolve()──► RESOLVED  (terminal)
 *      │
 *      └──cancelIfNotDelivered()──► CANCELLED  (terminal)
 *
 * CRITICAL: There is NO path from DELIVERED to RELEASED via timeout. Buyer inaction
 * after reviewDeadline always leads to DISPUTED (via escalateIfExpired), never to
 * automatic release. This is the central security guarantee.
 *
 * Fee model:
 *   - On confirmDelivery: fee is taken from the seller's gross payout.
 *   - On resolve: fee is taken proportionally from each party's allocated amount
 *     (buyer's fee from buyer's allocation, seller's fee from seller's allocation).
 */
contract EscrowV1 is ReentrancyGuard, Pausable, Ownable {
    using SafeERC20 for IERC20;

    // Pausable gates only the entry paths: createEscrow, dispute, resolve.
    // User-exit paths (confirmDelivery, cancelIfNotDelivered, escalateIfExpired,
    // markDelivered) are NEVER paused — funds must always be able to leave
    // the contract even if the owner suspends new disputes.

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum State { CREATED, DELIVERED, RELEASED, DISPUTED, RESOLVED, CANCELLED }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;             // USDC atomic units (6 decimals)
        uint64  deliveryDeadline;   // unix seconds — seller must markDelivered before this
        uint64  reviewDeadline;     // unix seconds — set when markDelivered is called
        uint64  reviewWindowSec;    // stored at creation for use in markDelivered
        State   state;
        bytes32 deliveryHash;       // hash of delivery payload (set on markDelivered)
        string  verificationURI;    // off-chain URL with verification criteria
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    mapping(uint256 => Escrow) public escrows;
    uint256 public nextEscrowId = 1; // 0 is reserved as sentinel

    address public arbiter;
    address public immutable usdc;
    uint16 public releaseFeeBps = 50;   // 0.5%, capped at 200 (2%)
    uint16 public resolveFeeBps = 200;  // 2.0%, capped at 500 (5%)
    address public feeRecipient;

    // -------------------------------------------------------------------------
    // Custom errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error SellerIsZero();
    error SellerIsBuyer();
    error AmountIsZero();
    error DeliveryWindowTooShort();
    error DeliveryWindowTooLong();
    error ReviewWindowTooShort();
    error ReviewWindowTooLong();

    error NotSeller();
    error NotBuyer();
    error NotBuyerOrSeller();
    error NotArbiter();

    error WrongState(State current);
    error DeliveryDeadlinePassed();
    error DeliveryDeadlineNotPassed();
    error ReviewDeadlineNotPassed();

    error BpsSumNot10000();
    error FeeBpsTooHigh();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event EscrowCreated(
        uint256 indexed id,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint64  deliveryDeadline,
        string  verificationURI
    );
    event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline);
    event Released(uint256 indexed id, uint256 toSeller, uint256 fee);
    event Disputed(uint256 indexed id, address indexed by, string reason);
    event Escalated(uint256 indexed id);
    event Resolved(
        uint256 indexed id,
        uint256 toBuyer,
        uint256 toSeller,
        uint256 fee,
        bytes32 verdictHash
    );
    event Cancelled(uint256 indexed id);
    event ArbiterChanged(address oldArbiter, address newArbiter);
    event FeeRecipientChanged(address oldRecipient, address newRecipient);
    event ReleaseFeeChanged(uint16 oldBps, uint16 newBps);
    event ResolveFeeChanged(uint16 oldBps, uint16 newBps);

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint64  private constant MIN_WINDOW          = 3_600;    // 1 hour
    uint64  private constant MAX_WINDOW          = 2_592_000; // 30 days
    uint16  private constant MAX_RELEASE_FEE_BPS = 200;
    uint16  private constant MAX_RESOLVE_FEE_BPS = 500;
    uint16  private constant BPS_DENOM           = 10_000;

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _usdc, address _arbiter, address _feeRecipient) Ownable(msg.sender) {
        if (_usdc         == address(0)) revert ZeroAddress();
        if (_arbiter      == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();

        usdc         = _usdc;
        arbiter      = _arbiter;
        feeRecipient = _feeRecipient;
    }

    // -------------------------------------------------------------------------
    // Owner configuration
    // -------------------------------------------------------------------------

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterChanged(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    function setFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientChanged(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function setReleaseFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_RELEASE_FEE_BPS) revert FeeBpsTooHigh();
        emit ReleaseFeeChanged(releaseFeeBps, bps);
        releaseFeeBps = bps;
    }

    function setResolveFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_RESOLVE_FEE_BPS) revert FeeBpsTooHigh();
        emit ResolveFeeChanged(resolveFeeBps, bps);
        resolveFeeBps = bps;
    }

    // Emergency circuit breaker. Only blocks create/dispute/resolve. Cannot
    // block users from exiting existing escrows via confirmDelivery, cancel,
    // escalateIfExpired, or markDelivered.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Core flow
    // -------------------------------------------------------------------------

    /**
     * @notice Create a new escrow. Buyer must have approved this contract for `amount` USDC.
     * @param seller             Counterparty receiving funds upon confirmed delivery.
     * @param amount             USDC amount in atomic units (6 decimals).
     * @param deliveryWindowSec  Seconds from now within which seller must markDelivered.
     * @param reviewWindowSec    Seconds from markDelivered within which buyer must act.
     * @param verificationURI    Off-chain URL describing verification criteria.
     * @return escrowId          The new escrow ID (starts at 1).
     */
    function createEscrow(
        address seller,
        uint256 amount,
        uint64  deliveryWindowSec,
        uint64  reviewWindowSec,
        string  calldata verificationURI
    ) external whenNotPaused returns (uint256 escrowId) {
        if (seller == address(0))              revert SellerIsZero();
        if (seller == msg.sender)              revert SellerIsBuyer();
        if (amount == 0)                       revert AmountIsZero();
        if (deliveryWindowSec < MIN_WINDOW)    revert DeliveryWindowTooShort();
        if (deliveryWindowSec > MAX_WINDOW)    revert DeliveryWindowTooLong();
        if (reviewWindowSec   < MIN_WINDOW)    revert ReviewWindowTooShort();
        if (reviewWindowSec   > MAX_WINDOW)    revert ReviewWindowTooLong();

        escrowId = nextEscrowId++;

        uint64 deliveryDeadline = uint64(block.timestamp) + deliveryWindowSec;

        escrows[escrowId] = Escrow({
            buyer:           msg.sender,
            seller:          seller,
            amount:          amount,
            deliveryDeadline: deliveryDeadline,
            reviewDeadline:   0,               // set on markDelivered
            reviewWindowSec:  reviewWindowSec,
            state:            State.CREATED,
            deliveryHash:     bytes32(0),
            verificationURI:  verificationURI
        });

        // Reverts if allowance or balance is insufficient (handled by SafeERC20).
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowCreated(escrowId, msg.sender, seller, amount, deliveryDeadline, verificationURI);
    }

    /**
     * @notice Seller signals that delivery is complete before deliveryDeadline.
     * @param id            Escrow ID.
     * @param deliveryHash  Hash of the delivery payload for off-chain verification.
     */
    function markDelivered(uint256 id, bytes32 deliveryHash) external {
        Escrow storage e = escrows[id];
        if (msg.sender != e.seller)              revert NotSeller();
        if (e.state != State.CREATED)            revert WrongState(e.state);
        if (block.timestamp > e.deliveryDeadline) revert DeliveryDeadlinePassed();

        e.state        = State.DELIVERED;
        e.deliveryHash = deliveryHash;

        uint64 reviewDeadline = uint64(block.timestamp) + e.reviewWindowSec;
        e.reviewDeadline = reviewDeadline;

        emit Delivered(id, deliveryHash, reviewDeadline);
    }

    /**
     * @notice Buyer confirms satisfactory delivery; releases funds to seller minus fee.
     */
    function confirmDelivery(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (msg.sender != e.buyer)      revert NotBuyer();
        if (e.state != State.DELIVERED) revert WrongState(e.state);

        e.state = State.RELEASED;

        // Fee taken from the seller's gross payout (buyer pays full amount, seller nets less).
        uint256 fee      = (e.amount * releaseFeeBps) / BPS_DENOM;
        uint256 toSeller = e.amount - fee;

        IERC20(usdc).safeTransfer(e.seller, toSeller);
        if (fee > 0) IERC20(usdc).safeTransfer(feeRecipient, fee);

        emit Released(id, toSeller, fee);
    }

    /**
     * @notice Either party may dispute in CREATED or DELIVERED state.
     *         Buyer disputes non-delivery or bad delivery; seller may dispute
     *         a refusal to cancel after deliveryDeadline has passed.
     * @param id      Escrow ID.
     * @param reason  Human-readable dispute reason (emitted as event, not stored on-chain).
     */
    function dispute(uint256 id, string calldata reason) external whenNotPaused {
        Escrow storage e = escrows[id];
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotBuyerOrSeller();
        if (e.state != State.CREATED && e.state != State.DELIVERED) revert WrongState(e.state);

        e.state = State.DISPUTED;

        emit Disputed(id, msg.sender, reason);
    }

    /**
     * @notice Public safety valve: escalates a DELIVERED escrow to DISPUTED after
     *         reviewDeadline passes. Callable by anyone so escrow can never be silently
     *         stuck in DELIVERED forever.
     */
    function escalateIfExpired(uint256 id) external {
        Escrow storage e = escrows[id];
        if (e.state != State.DELIVERED)          revert WrongState(e.state);
        if (block.timestamp <= e.reviewDeadline) revert ReviewDeadlineNotPassed();

        e.state = State.DISPUTED;

        emit Escalated(id);
    }

    /**
     * @notice Buyer cancels and receives a full refund if seller missed the deliveryDeadline.
     */
    function cancelIfNotDelivered(uint256 id) external nonReentrant {
        Escrow storage e = escrows[id];
        if (msg.sender != e.buyer)               revert NotBuyer();
        if (e.state != State.CREATED)            revert WrongState(e.state);
        if (block.timestamp <= e.deliveryDeadline) revert DeliveryDeadlineNotPassed();

        e.state = State.CANCELLED;

        IERC20(usdc).safeTransfer(e.buyer, e.amount);

        emit Cancelled(id);
    }

    // -------------------------------------------------------------------------
    // Arbiter
    // -------------------------------------------------------------------------

    /**
     * @notice Arbiter resolves a disputed escrow by splitting funds per basis points.
     *         Fee is deducted proportionally: buyer's fee from buyer's allocation,
     *         seller's fee from seller's allocation. buyerBps + sellerBps must equal 10000.
     * @param id          Escrow ID.
     * @param buyerBps    Basis points of total amount allocated to buyer (0–10000).
     * @param sellerBps   Basis points of total amount allocated to seller (0–10000).
     * @param verdictHash Hash of the arbiter's verdict document for off-chain audit trail.
     */
    function resolve(
        uint256 id,
        uint16  buyerBps,
        uint16  sellerBps,
        bytes32 verdictHash
    ) external nonReentrant whenNotPaused {
        if (msg.sender != arbiter)    revert NotArbiter();

        Escrow storage e = escrows[id];
        if (e.state != State.DISPUTED) revert WrongState(e.state);

        // Widened to uint32 to prevent overflow in the sum check.
        if (uint32(buyerBps) + uint32(sellerBps) != uint32(BPS_DENOM)) revert BpsSumNot10000();

        e.state = State.RESOLVED;

        uint256 toBuyer;
        uint256 toSeller;
        uint256 totalFee;
        {
            // Scope intermediate vars so they free up stack before transfers.
            uint256 buyerGross  = (e.amount * buyerBps)  / BPS_DENOM;
            uint256 sellerGross = (e.amount * sellerBps) / BPS_DENOM;
            uint256 buyerFee    = (buyerGross  * resolveFeeBps) / BPS_DENOM;
            uint256 sellerFee   = (sellerGross * resolveFeeBps) / BPS_DENOM;
            totalFee  = buyerFee + sellerFee;
            toBuyer   = buyerGross  - buyerFee;
            toSeller  = sellerGross - sellerFee;
        }

        if (toBuyer  > 0) IERC20(usdc).safeTransfer(e.buyer,       toBuyer);
        if (toSeller > 0) IERC20(usdc).safeTransfer(e.seller,      toSeller);
        if (totalFee > 0) IERC20(usdc).safeTransfer(feeRecipient,  totalFee);

        emit Resolved(id, toBuyer, toSeller, totalFee, verdictHash);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getEscrow(uint256 id) external view returns (Escrow memory) {
        return escrows[id];
    }
}
