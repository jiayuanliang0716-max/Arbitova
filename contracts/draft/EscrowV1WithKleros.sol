// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title EscrowV1WithKleros (DRAFT v0.2 — not for deployment)
 * @notice Two-tier arbitration sketch for EscrowV1. Matches the design
 *         in docs/two-tier-arbitration-design.md. First instance is the
 *         existing Arbitova arbiter (Claude ensemble + multisig);
 *         appeal tier is Kleros v2.
 *
 * Status: v0.2 sketch. Does NOT compile against live EscrowV1 without
 *         surgery; meant to show the intended state machine, storage
 *         additions, guard placement, and edge-case handling that a
 *         real amendment must preserve. Use as a contract reviewer's
 *         starting point, not a diff.
 *
 * Remediation audit findings addressed in this draft (remediation-plan.md):
 *   - C-2  appeal/finalize race: appeal() atomically flips state via
 *          a single require-and-set under nonReentrant; finalize() rejects
 *          if dispute already opened.
 *   - C-3  Kleros ruling=0 (refused to rule): revert to provisional
 *          verdict AND refund appellant bond; Kleros fee is treated as
 *          a cost of trying.
 *   - C-4  Kleros-dead fallback: finalizeStalled() activates after
 *          klerosFallbackPeriod if the rule() callback never fires.
 *   - M-7  Pausable gates on create/dispute/resolve/appeal; user-exit
 *          paths (cancelIfNotDelivered, escalateIfExpired, finalize,
 *          finalizeStalled, rule) are NOT gated — funds can always exit.
 *   - M-8  Front-run defense: appeal() restricted to the losing party
 *          of the provisional ruling. Mempool races by the winning
 *          party are impossible because they cannot call appeal().
 */

// -----------------------------------------------------------------------------
// IArbitratorV2 / IArbitrableV2 — minimal interface sketch
// -----------------------------------------------------------------------------

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
    /// @param ruling    1..numberOfRulings, or 0 for "refused to rule".
    function rule(uint256 disputeId, uint256 ruling) external;
}

// -----------------------------------------------------------------------------
// Draft extension
// -----------------------------------------------------------------------------

abstract contract EscrowV1WithKleros is IArbitrableV2 {
    // -------------------------------------------------------------------------
    // Storage — additive; existing EscrowV1 layout unchanged
    // -------------------------------------------------------------------------

    struct Provisional {
        uint16 buyerBps;
        uint16 sellerBps;
        bytes32 verdictHash;
        uint64 resolvedAt;   // seconds; 0 = no provisional ruling yet
    }

    struct Appeal {
        address appellant;           // losing party who posted bond
        uint256 bond;                // amount of bond escrowed (ETH in v0.1)
        uint256 disputeId;           // Kleros dispute id
        uint64 createdAt;            // when UNDER_APPEAL started
        bool ruled;                  // rule() callback fired
    }

    mapping(uint256 => Provisional) public provisional;    // escrowId → ruling
    mapping(uint256 => Appeal)      public appealOf;       // escrowId → appeal
    mapping(uint256 => uint256)     public klerosDisputeToEscrow;

    address public klerosArbitrator;
    bytes   public klerosExtraData;

    /// @dev Appeal window after a provisional ruling. Default 7 days.
    uint64 public appealWindow = 7 days;

    /// @dev If Kleros never fires rule() within this period after appeal,
    ///      anyone may finalizeStalled() and revert to the provisional verdict.
    ///      Default 90 days — chosen to be clearly longer than any healthy
    ///      Kleros v2 round.
    uint64 public klerosFallbackPeriod = 90 days;

    /// @dev Circuit breaker. Blocks new disputes/appeals/first-instance
    ///      resolutions. Does NOT block user-exit paths (finalize,
    ///      finalizeStalled, cancelIfNotDelivered, escalateIfExpired, rule).
    bool public paused;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotKlerosArbitrator();
    error UnknownDisputeId();
    error InvalidRuling(uint256 ruling);
    error NotProvisional();
    error NotUnderAppeal();
    error AppealWindowClosed();
    error AppealWindowOpen();
    error NotLosingParty();
    error DuplicateAppeal();
    error ArbitrationFeeUnderpaid(uint256 required, uint256 sent);
    error BondTransferFailed();
    error FallbackPeriodNotReached();
    error Paused();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event FirstInstanceResolved(
        uint256 indexed escrowId,
        uint16 buyerBps,
        uint16 sellerBps,
        bytes32 verdictHash,
        uint64 resolvedAt
    );
    event Appealed(
        uint256 indexed escrowId,
        address indexed appellant,
        uint256 bond,
        uint256 indexed disputeId
    );
    event Finalized(uint256 indexed escrowId, bytes32 verdictHash);
    event KlerosRuled(
        uint256 indexed escrowId,
        uint256 indexed disputeId,
        uint256 ruling,
        uint16 buyerBps,
        uint16 sellerBps
    );
    event KlerosRefused(uint256 indexed escrowId, uint256 indexed disputeId);
    event KlerosFallback(uint256 indexed escrowId, uint256 indexed disputeId);
    event Paused_(address actor, bool state);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // -------------------------------------------------------------------------
    // First instance
    // -------------------------------------------------------------------------

    /**
     * @notice Arbiter (Arbitova multisig) records the first-instance verdict.
     *         Transitions DISPUTED → PROVISIONAL_RESOLVED. Starts the appeal
     *         clock. Funds are NOT paid out yet.
     *
     * Guards:
     *   - onlyArbiter (enforced in override in real contract)
     *   - whenNotPaused
     *   - nonReentrant (enforced in override in real contract)
     *   - state(escrowId) must be DISPUTED
     *   - buyerBps + sellerBps == 10_000
     */
    function resolveFirstInstance(
        uint256 escrowId,
        uint16  buyerBps,
        uint16  sellerBps,
        bytes32 verdictHash
    ) external virtual whenNotPaused {
        require(buyerBps + sellerBps == 10_000, "bps sum");
        _requireStateDisputed(escrowId);

        provisional[escrowId] = Provisional({
            buyerBps:   buyerBps,
            sellerBps:  sellerBps,
            verdictHash: verdictHash,
            resolvedAt: uint64(block.timestamp)
        });

        _setStateProvisionalResolved(escrowId);

        emit FirstInstanceResolved(
            escrowId, buyerBps, sellerBps, verdictHash, uint64(block.timestamp)
        );
    }

    // -------------------------------------------------------------------------
    // Appeal — M-8 front-run defense: only the losing party may call
    // -------------------------------------------------------------------------

    /**
     * @notice The losing party of the provisional ruling escalates to Kleros.
     *         Transitions PROVISIONAL_RESOLVED → UNDER_APPEAL atomically.
     *
     * M-8 (front-run defense):
     *   `require(msg.sender == losingParty(escrowId))`. The winning party
     *   cannot call appeal(), so no mempool sandwich is possible. On a
     *   50/50 split both parties are treated as "losing" and either may
     *   appeal — documented as an accepted edge case since stakes are
     *   symmetric.
     *
     * C-2 (race with finalize):
     *   The appeal() entrypoint and finalize() entrypoint are mutually
     *   exclusive because they require different states. appeal()
     *   requires PROVISIONAL_RESOLVED; on entry it immediately sets
     *   state=UNDER_APPEAL before the external Kleros call. finalize()
     *   rejects any state other than PROVISIONAL_RESOLVED. Even if both
     *   land in the same block, the second to execute reverts.
     *
     *   `nonReentrant` wraps the external `createDispute` call.
     *
     * Preconditions:
     *   - state(escrowId) == PROVISIONAL_RESOLVED
     *   - block.timestamp <= provisional.resolvedAt + appealWindow
     *   - msg.sender is the losing party (or 50/50 → either)
     *   - no existing appeal
     *   - msg.value >= arbitrationCost + minBond
     */
    function appeal(uint256 escrowId)
        external
        payable
        virtual
        whenNotPaused
    {
        Provisional memory prov = provisional[escrowId];
        if (prov.resolvedAt == 0) revert NotProvisional();
        _requireStateProvisionalResolved(escrowId);
        if (appealOf[escrowId].createdAt != 0) revert DuplicateAppeal();

        if (block.timestamp > prov.resolvedAt + appealWindow) {
            revert AppealWindowClosed();
        }

        if (!_isLosingParty(escrowId, msg.sender, prov)) {
            revert NotLosingParty();
        }

        // Compute Kleros cost and required bond.
        uint256 klerosFee = IArbitratorV2(klerosArbitrator)
            .arbitrationCost(klerosExtraData);
        uint256 requiredBond = _requiredAppealBond(escrowId, klerosFee);

        if (msg.value < requiredBond) {
            revert ArbitrationFeeUnderpaid(requiredBond, msg.value);
        }

        // Flip state BEFORE the external call to Kleros.
        _setStateUnderAppeal(escrowId);

        uint256 disputeId = IArbitratorV2(klerosArbitrator)
            .createDispute{value: klerosFee}(2, klerosExtraData);

        uint256 bond = msg.value - klerosFee;
        appealOf[escrowId] = Appeal({
            appellant: msg.sender,
            bond:      bond,
            disputeId: disputeId,
            createdAt: uint64(block.timestamp),
            ruled:     false
        });
        klerosDisputeToEscrow[disputeId] = escrowId;

        emit Appealed(escrowId, msg.sender, bond, disputeId);
    }

    // -------------------------------------------------------------------------
    // Finalize — no-appeal path
    // -------------------------------------------------------------------------

    /**
     * @notice If the appeal window passed with no appeal, anyone may
     *         finalize and pay out per the provisional verdict.
     *         PROVISIONAL_RESOLVED → RESOLVED.
     *
     * NOT paused-gated so the escrow's funds can exit even if Arbitova
     * pauses everything else.
     */
    function finalize(uint256 escrowId) external virtual {
        Provisional memory prov = provisional[escrowId];
        if (prov.resolvedAt == 0) revert NotProvisional();
        _requireStateProvisionalResolved(escrowId);
        if (appealOf[escrowId].createdAt != 0) revert DuplicateAppeal();

        if (block.timestamp <= prov.resolvedAt + appealWindow) {
            revert AppealWindowOpen();
        }

        _resolve(escrowId, prov.buyerBps, prov.sellerBps, prov.verdictHash);
        emit Finalized(escrowId, prov.verdictHash);
    }

    // -------------------------------------------------------------------------
    // Kleros callback
    // -------------------------------------------------------------------------

    /**
     * @inheritdoc IArbitrableV2
     *
     * Ruling mapping:
     *   0 → Kleros jury refused to rule.                       (C-3)
     *       We fall back to the provisional verdict and REFUND
     *       the appellant's bond. Kleros has already been paid;
     *       losing the bond in addition would be double-punishment
     *       for a juror failure that the parties did not cause.
     *   1 → buyer wins (10_000 / 0)
     *   2 → seller wins (0 / 10_000)
     *   >2 → revert
     *
     * Bond logic (only for ruling ∈ {1,2}):
     *   - If Kleros ruling differs from provisional → bond refunded
     *     (first instance was wrong; appellant was right to appeal).
     *   - If Kleros ruling matches provisional    → bond forfeited.
     *     Forfeited bond is paid into the protocol fee sink.
     */
    function rule(uint256 disputeId, uint256 ruling)
        external
        virtual
        override
    {
        if (msg.sender != klerosArbitrator) revert NotKlerosArbitrator();

        uint256 escrowId = klerosDisputeToEscrow[disputeId];
        if (escrowId == 0) revert UnknownDisputeId();

        Appeal storage a = appealOf[escrowId];
        if (a.createdAt == 0 || a.ruled) revert UnknownDisputeId();
        a.ruled = true;

        Provisional memory prov = provisional[escrowId];

        if (ruling == 0) {
            // C-3: refused to rule → provisional verdict stands, refund bond.
            _refundBond(a.appellant, a.bond);
            _resolve(escrowId, prov.buyerBps, prov.sellerBps, prov.verdictHash);
            emit KlerosRefused(escrowId, disputeId);
            return;
        }

        if (ruling > 2) revert InvalidRuling(ruling);

        (uint16 buyerBps, uint16 sellerBps) = ruling == 1
            ? (uint16(10_000), uint16(0))
            : (uint16(0),      uint16(10_000));

        // Bond refund/forfeit decision.
        bool reversed = (buyerBps != prov.buyerBps);
        if (reversed) {
            _refundBond(a.appellant, a.bond);
        } else {
            _forfeitBondToProtocol(a.bond);
        }

        bytes32 verdictHash = keccak256(abi.encodePacked("kleros:", disputeId));
        _resolve(escrowId, buyerBps, sellerBps, verdictHash);

        emit KlerosRuled(escrowId, disputeId, ruling, buyerBps, sellerBps);
    }

    // -------------------------------------------------------------------------
    // C-4: fallback if Kleros never fires rule()
    // -------------------------------------------------------------------------

    /**
     * @notice If Kleros is paused/upgrading/dead and never calls rule()
     *         within klerosFallbackPeriod of the appeal, anyone may
     *         push the escrow back to the provisional verdict so funds
     *         aren't locked forever. Bond is refunded to the appellant
     *         (they did nothing wrong; the arbitrator failed).
     *
     * NOT paused-gated — exit path.
     */
    function finalizeStalled(uint256 escrowId) external virtual {
        Appeal storage a = appealOf[escrowId];
        if (a.createdAt == 0 || a.ruled) revert NotUnderAppeal();

        if (block.timestamp < a.createdAt + klerosFallbackPeriod) {
            revert FallbackPeriodNotReached();
        }

        a.ruled = true;

        Provisional memory prov = provisional[escrowId];
        _refundBond(a.appellant, a.bond);
        _resolve(escrowId, prov.buyerBps, prov.sellerBps, prov.verdictHash);

        emit KlerosFallback(escrowId, a.disputeId);
    }

    // -------------------------------------------------------------------------
    // M-7: Pausable admin
    // -------------------------------------------------------------------------

    /// @dev Owner-gated in override. Pausing blocks create/dispute/
    ///      resolve/appeal. User-exit paths remain open.
    function setPaused(bool newPaused) external virtual {
        paused = newPaused;
        emit Paused_(msg.sender, newPaused);
    }

    // -------------------------------------------------------------------------
    // Internal helpers (abstract — real contract supplies bodies)
    // -------------------------------------------------------------------------

    /// @dev State transitions performed on the underlying EscrowV1 storage.
    function _requireStateDisputed(uint256 escrowId) internal view virtual;
    function _requireStateProvisionalResolved(uint256 escrowId) internal view virtual;
    function _setStateProvisionalResolved(uint256 escrowId) internal virtual;
    function _setStateUnderAppeal(uint256 escrowId) internal virtual;

    /// @dev Returns true if `who` is the party that lost in the provisional
    ///      ruling (i.e., the one receiving <5_000 bps). On a 50/50 split
    ///      both parties are considered losing so either may appeal.
    function _isLosingParty(
        uint256 escrowId,
        address who,
        Provisional memory prov
    ) internal view virtual returns (bool);

    /// @dev Concrete contract maps escrowId → (buyer, seller) addresses.
    ///      Used by _isLosingParty.
    // function parties(uint256 escrowId)
    //     internal view virtual returns (address buyer, address seller);

    /// @dev Inherited from EscrowV1 in the real contract; used by
    ///      resolveFirstInstance-without-payout is implicit (no payout),
    ///      and by finalize / finalizeStalled / rule which do pay out.
    function _resolve(
        uint256 escrowId,
        uint16  buyerBps,
        uint16  sellerBps,
        bytes32 verdictHash
    ) internal virtual;

    /// @dev Send bond back to appellant. Real contract uses SafeTransferLib
    ///      or explicit call with bubble-up.
    function _refundBond(address to, uint256 amount) internal virtual {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert BondTransferFailed();
    }

    /// @dev Push forfeited bond into protocol fee sink.
    function _forfeitBondToProtocol(uint256 amount) internal virtual;

    /// @dev Appeal bond formula:  max(klerosFee × 1.2, escrowAmount × 10%).
    ///      Concrete contract reads escrowAmount from its own storage.
    function _requiredAppealBond(uint256 escrowId, uint256 klerosFee)
        internal
        view
        virtual
        returns (uint256);
}
