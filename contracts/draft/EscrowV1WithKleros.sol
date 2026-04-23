// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EscrowV1WithKleros (DRAFT — not for deployment)
 * @notice Illustrative extension of EscrowV1 that routes disputes to a
 *         Kleros v2 arbitrator when the escrow was created with the
 *         KLEROS arbiter flag. Lives in contracts/draft/ intentionally
 *         to keep it off the audit surface until the plan in
 *         docs/kleros-v2-integration-plan.md is approved.
 *
 * Status: v0.1 sketch. Does NOT compile against the live EscrowV1 ABI
 *         without surgery; it is a design illustration. The real change
 *         should be made as a surgical amendment to EscrowV1.sol once
 *         the Kleros plan is locked.
 *
 * Scope:
 *   - Two arbiter modes per escrow: SELF_ARBITER (current Claude + multisig
 *     path) or KLEROS (Kleros v2 arbitrator contract).
 *   - On dispute(KLEROS), EscrowV1 calls `klerosArbitrator.createDispute`
 *     and stores a bidirectional mapping between the Kleros disputeId
 *     and the escrow id.
 *   - On callback `rule(disputeId, ruling)`, the contract maps the
 *     ruling to (buyerBps, sellerBps) and routes funds through the
 *     same RESOLVED path used by the self-arbiter.
 *
 * What this DOES NOT change:
 *   - SELF_ARBITER escrows behave exactly as today. No new trust edge.
 *   - Fee model, state enum order, and event ABIs stay backwards
 *     compatible. A new event `DisputedViaKleros` is additive.
 */

// -----------------------------------------------------------------------------
// IArbitratorV2 — minimal interface sketch
// -----------------------------------------------------------------------------
// The real Kleros v2 IArbitratorV2 has more surface area (subcourt params,
// extra-data, funding). This sketch keeps only what v0.1 routing requires.

interface IArbitratorV2 {
    function createDispute(uint256 numberOfRulings, bytes calldata extraData)
        external
        payable
        returns (uint256 disputeId);

    function arbitrationCost(bytes calldata extraData)
        external
        view
        returns (uint256 fee);
}

interface IArbitrableV2 {
    /// @notice Called by the arbitrator once a ruling is final.
    /// @param disputeId the id returned by createDispute.
    /// @param ruling   1..numberOfRulings, or 0 for "refused to rule".
    function rule(uint256 disputeId, uint256 ruling) external;
}

// -----------------------------------------------------------------------------
// Draft extension
// -----------------------------------------------------------------------------

/// @dev Pseudo-code: these are the fields / functions that would be *added*
///      to EscrowV1.sol. This file is a sketch, not a drop-in superset.
abstract contract EscrowV1WithKleros is IArbitrableV2 {
    enum ArbiterKind { SELF_ARBITER, KLEROS }

    // Per-escrow arbiter selection. Existing escrows implicitly map to
    // SELF_ARBITER (enum index 0) in storage layout terms.
    mapping(uint256 => ArbiterKind) public escrowArbiterKind;

    // The single Kleros v2 arbitrator this deployment talks to. Settable
    // by owner so that Sepolia and mainnet can point at the appropriate
    // arbitrator (Kleros deploys one per network).
    address public klerosArbitrator;

    // Subcourt / arbitration params. Opaque bytes per Kleros convention.
    // Stored once; if per-escrow granularity is needed later, move to
    // the Escrow struct. v0.1 picks deployment-wide.
    bytes public klerosExtraData;

    // disputeId → escrowId. Kleros only gives us disputeId in the callback.
    mapping(uint256 => uint256) public klerosDisputeToEscrow;

    // escrowId → disputeId, for introspection. 0 means not-yet-disputed.
    mapping(uint256 => uint256) public escrowToKlerosDispute;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotKlerosArbitrator();
    error NotAKlerosEscrow();
    error ArbitrationFeeUnderpaid(uint256 required, uint256 sent);
    error DisputeAlreadyCreated();
    error UnknownDisputeId();
    error InvalidRuling(uint256 ruling);

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event KlerosArbitratorSet(address indexed previous, address indexed current);
    event KlerosExtraDataSet(bytes previous, bytes current);
    event DisputedViaKleros(
        uint256 indexed escrowId,
        uint256 indexed disputeId,
        address disputer,
        uint256 feePaid
    );
    event KlerosRuled(
        uint256 indexed escrowId,
        uint256 indexed disputeId,
        uint256 ruling,
        uint16 buyerBps,
        uint16 sellerBps
    );

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /// @dev Guarded by onlyOwner in the real contract. Unguarded here to
    ///      keep the sketch compile-time self-contained.
    function setKlerosArbitrator(address newArbitrator) external virtual {
        emit KlerosArbitratorSet(klerosArbitrator, newArbitrator);
        klerosArbitrator = newArbitrator;
    }

    function setKlerosExtraData(bytes calldata newExtraData) external virtual {
        emit KlerosExtraDataSet(klerosExtraData, newExtraData);
        klerosExtraData = newExtraData;
    }

    // -------------------------------------------------------------------------
    // Dispute entrypoint
    // -------------------------------------------------------------------------

    /**
     * @notice Route an existing DISPUTED escrow to the Kleros arbitrator.
     *         Separate from `dispute(...)` so that the existing
     *         SELF_ARBITER call surface stays unchanged. The caller
     *         (buyer or seller) attaches the Kleros arbitration fee.
     *
     * @param escrowId the id of an escrow already in DISPUTED state and
     *                 flagged as KLEROS at creation time.
     *
     * Preconditions:
     *   - escrow exists, is KLEROS-flagged, and is in DISPUTED state
     *   - escrow has no existing Kleros dispute
     *   - msg.value >= klerosArbitrator.arbitrationCost(klerosExtraData)
     *
     * Post-state:
     *   - klerosDisputeToEscrow[disputeId] = escrowId
     *   - escrowToKlerosDispute[escrowId]  = disputeId
     *   - emits DisputedViaKleros
     */
    function disputeViaKleros(uint256 escrowId) external payable virtual {
        ArbiterKind kind = escrowArbiterKind[escrowId];
        if (kind != ArbiterKind.KLEROS) revert NotAKlerosEscrow();
        if (escrowToKlerosDispute[escrowId] != 0) revert DisputeAlreadyCreated();

        uint256 required = IArbitratorV2(klerosArbitrator)
            .arbitrationCost(klerosExtraData);
        if (msg.value < required) {
            revert ArbitrationFeeUnderpaid(required, msg.value);
        }

        // 2 rulings: 1 = buyer wins, 2 = seller wins. 0 = refused.
        uint256 disputeId = IArbitratorV2(klerosArbitrator)
            .createDispute{value: required}(2, klerosExtraData);

        klerosDisputeToEscrow[disputeId] = escrowId;
        escrowToKlerosDispute[escrowId]  = disputeId;

        emit DisputedViaKleros(escrowId, disputeId, msg.sender, required);

        // Refund any overpayment to the caller.
        if (msg.value > required) {
            (bool ok, ) = msg.sender.call{value: msg.value - required}("");
            require(ok, "refund failed");
        }
    }

    // -------------------------------------------------------------------------
    // Kleros callback
    // -------------------------------------------------------------------------

    /**
     * @inheritdoc IArbitrableV2
     *
     * Ruling → bps mapping:
     *   0 → 50/50 split (Kleros jury refused to rule)
     *   1 → buyer wins (buyerBps = 10_000, sellerBps = 0)
     *   2 → seller wins (buyerBps = 0, sellerBps = 10_000)
     *   >2 → revert InvalidRuling(ruling)
     *
     * The mapped bps are fed into the same internal `_resolve(escrowId,
     * buyerBps, sellerBps, verdictHash)` routine used by the
     * SELF_ARBITER path. A verdictHash of `keccak256("kleros:", disputeId)`
     * is stored so that observers can distinguish Kleros verdicts from
     * self-arbiter ones in event logs.
     */
    function rule(uint256 disputeId, uint256 ruling) external virtual override {
        if (msg.sender != klerosArbitrator) revert NotKlerosArbitrator();

        uint256 escrowId = klerosDisputeToEscrow[disputeId];
        if (escrowId == 0) revert UnknownDisputeId();

        (uint16 buyerBps, uint16 sellerBps) = _rulingToBps(ruling);

        bytes32 verdictHash = keccak256(
            abi.encodePacked("kleros:", disputeId)
        );

        // NOTE: _resolve is inherited from the real EscrowV1. In this
        // draft file we only declare the call shape; the body is
        // intentionally not present.
        _resolve(escrowId, buyerBps, sellerBps, verdictHash);

        emit KlerosRuled(escrowId, disputeId, ruling, buyerBps, sellerBps);
    }

    function _rulingToBps(uint256 ruling)
        internal
        pure
        returns (uint16 buyerBps, uint16 sellerBps)
    {
        if (ruling == 0)      return (5_000, 5_000);
        if (ruling == 1)      return (10_000, 0);
        if (ruling == 2)      return (0, 10_000);
        revert InvalidRuling(ruling);
    }

    // -------------------------------------------------------------------------
    // Stub for what the real contract provides
    // -------------------------------------------------------------------------

    /// @dev In the real EscrowV1 this is the internal resolution routine
    ///      invoked by both the self-arbiter `resolve(...)` and the
    ///      Kleros callback `rule(...)`. Left abstract here.
    function _resolve(
        uint256 escrowId,
        uint16  buyerBps,
        uint16  sellerBps,
        bytes32 verdictHash
    ) internal virtual;
}
