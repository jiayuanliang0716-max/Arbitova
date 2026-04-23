// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title ReputationV1
 * @notice Soulbound (non-transferable) ERC-721 that records completed
 *         or resolved escrows on behalf of Arbitova's EscrowV1.
 *
 * Design:
 *   - One token per completed/resolved escrow per participant.
 *     A happy-path RELEASED escrow mints two tokens: one to the buyer
 *     (role = BUYER_OK) and one to the seller (role = SELLER_OK).
 *     A RESOLVED escrow mints two tokens with roles BUYER_WON/BUYER_LOST
 *     and SELLER_WON/SELLER_LOST based on the on-chain split.
 *     A CANCELLED escrow mints nothing — neither party completed.
 *   - Tokens are soulbound: all transfers revert except mint and
 *     burn-by-admin-as-mistake (see burn() below; capped behavior).
 *   - Only the configured EscrowV1 address can call mint().
 *   - tokenURI returns a JSON blob pointing at the escrow verdict
 *     (for RESOLVED) or release receipt (for RELEASED) on Basescan.
 *
 * This contract does NOT implement fungible "reputation score" math.
 * Scoring belongs off-chain where weights can evolve; the NFT is the
 * raw signal, not the derived score.
 *
 * Status: v0.1 draft. Not deployed. Gated on:
 *   - Audit of EscrowV1
 *   - Decision on deploy ordering relative to the Phase 6 UMA
 *     Optimistic Oracle appeal research (see
 *     docs/decisions/M-0-arbiter-architecture-v1.md)
 *   - Product review of soulbound vs. transferable (current design:
 *     soulbound to prevent reputation-mule selling)
 */
contract ReputationV1 is ERC721, Ownable {
    using Strings for uint256;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Role {
        BUYER_OK,        // Happy path: buyer confirmed, funds released
        SELLER_OK,       // Happy path mirror
        BUYER_WON,       // Disputed: arbiter split favored buyer (>5000 bps)
        BUYER_LOST,      // Disputed: arbiter split disfavored buyer (<5000 bps)
        SELLER_WON,      // Disputed: seller received >5000 bps
        SELLER_LOST      // Disputed: seller received <5000 bps
    }

    struct Receipt {
        uint256 escrowId;       // id from EscrowV1
        address counterparty;   // the other side of the escrow
        uint256 amount;         // USDC atomic units (6 decimals)
        Role    role;
        uint64  mintedAt;       // block.timestamp
        bytes32 verdictHash;    // 0x0 if RELEASED, set if RESOLVED
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    address public escrowContract;
    uint256 public nextTokenId = 1;

    mapping(uint256 => Receipt) public receipts;

    string public baseDescription =
        "Arbitova reputation receipt. One token per completed escrow. "
        "Soulbound (non-transferable).";
    string public escrowExplorerBase =
        "https://sepolia.basescan.org/address/";

    // -------------------------------------------------------------------------
    // Errors + events
    // -------------------------------------------------------------------------

    error OnlyEscrow();
    error SoulboundNoTransfer();
    error InvalidAddress();

    event ReceiptMinted(
        uint256 indexed tokenId,
        address indexed to,
        uint256 indexed escrowId,
        Role role
    );

    event EscrowContractSet(address indexed previous, address indexed current);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address initialOwner, address escrowContract_)
        ERC721("Arbitova Reputation", "AREP")
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || escrowContract_ == address(0)) {
            revert InvalidAddress();
        }
        escrowContract = escrowContract_;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setEscrowContract(address newEscrow) external onlyOwner {
        if (newEscrow == address(0)) revert InvalidAddress();
        emit EscrowContractSet(escrowContract, newEscrow);
        escrowContract = newEscrow;
    }

    function setExplorerBase(string calldata newBase) external onlyOwner {
        escrowExplorerBase = newBase;
    }

    function setBaseDescription(string calldata newDescription) external onlyOwner {
        baseDescription = newDescription;
    }

    // -------------------------------------------------------------------------
    // Minting
    // -------------------------------------------------------------------------

    /**
     * @notice Mint a reputation receipt. Only the configured EscrowV1 may call.
     *
     * @param to            recipient (buyer or seller)
     * @param escrowId      matching EscrowV1 id
     * @param counterparty  the other side of this escrow
     * @param amount        escrow amount in USDC atomic units
     * @param role          role classification (see Role enum)
     * @param verdictHash   verdict hash for RESOLVED escrows; 0x0 for RELEASED
     * @return tokenId      newly minted token id
     */
    function mint(
        address to,
        uint256 escrowId,
        address counterparty,
        uint256 amount,
        Role    role,
        bytes32 verdictHash
    ) external returns (uint256 tokenId) {
        if (msg.sender != escrowContract) revert OnlyEscrow();
        if (to == address(0)) revert InvalidAddress();

        tokenId = nextTokenId++;
        receipts[tokenId] = Receipt({
            escrowId:      escrowId,
            counterparty:  counterparty,
            amount:        amount,
            role:          role,
            mintedAt:      uint64(block.timestamp),
            verdictHash:   verdictHash
        });

        _mint(to, tokenId);
        emit ReceiptMinted(tokenId, to, escrowId, role);
    }

    // -------------------------------------------------------------------------
    // Soulbound enforcement
    // -------------------------------------------------------------------------

    /**
     * @dev OpenZeppelin ERC721 (v5) centralizes all state changes in _update.
     *      Block transfers by requiring that the transition is either a mint
     *      (from == 0) or a burn (to == 0). Owner-initiated burn is blocked
     *      too: receipts are intentionally immutable once minted.
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        virtual
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert SoulboundNoTransfer();
        }
        return super._update(to, tokenId, auth);
    }

    // Explicitly disable approve semantics so dApps don't silently set them.
    function approve(address, uint256) public virtual override {
        revert SoulboundNoTransfer();
    }

    function setApprovalForAll(address, bool) public virtual override {
        revert SoulboundNoTransfer();
    }

    // -------------------------------------------------------------------------
    // Metadata
    // -------------------------------------------------------------------------

    function tokenURI(uint256 tokenId)
        public
        view
        override
        returns (string memory)
    {
        _requireOwned(tokenId);
        Receipt memory r = receipts[tokenId];
        // Data-URI JSON; off-chain indexers can read role + escrow id without
        // relying on an external host. Keep the JSON deliberately minimal.
        return string(
            abi.encodePacked(
                "data:application/json;utf8,",
                "{",
                    "\"name\":\"Arbitova Receipt #", tokenId.toString(), "\",",
                    "\"description\":\"", baseDescription, "\",",
                    "\"attributes\":[",
                        "{\"trait_type\":\"Escrow ID\",\"value\":", r.escrowId.toString(), "},",
                        "{\"trait_type\":\"Role\",\"value\":\"", _roleName(r.role), "\"},",
                        "{\"trait_type\":\"Amount\",\"value\":", r.amount.toString(), "}",
                    "]",
                "}"
            )
        );
    }

    function _roleName(Role role) internal pure returns (string memory) {
        if (role == Role.BUYER_OK)     return "BUYER_OK";
        if (role == Role.SELLER_OK)    return "SELLER_OK";
        if (role == Role.BUYER_WON)    return "BUYER_WON";
        if (role == Role.BUYER_LOST)   return "BUYER_LOST";
        if (role == Role.SELLER_WON)   return "SELLER_WON";
        return "SELLER_LOST";
    }
}
