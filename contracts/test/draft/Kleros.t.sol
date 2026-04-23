// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title KlerosDraftTest
 * @notice Sketch of the forge test cases we will want once the real
 *         EscrowV1WithKleros extension lands. Kept in `test/draft/` to
 *         signal intent without polluting the CI suite.
 *
 * These tests do NOT pass as written — they reference a contract that
 * is itself a draft (contracts/draft/EscrowV1WithKleros.sol). They
 * exist to pin down the happy-path + edge-case contract behavior we
 * need to verify before a Sepolia testnet deploy.
 *
 * Coverage targets:
 *   1. disputeViaKleros only works on KLEROS-flagged escrows in DISPUTED
 *      state (reverts NotAKlerosEscrow otherwise).
 *   2. disputeViaKleros reverts ArbitrationFeeUnderpaid when msg.value
 *      is below arbitrationCost.
 *   3. disputeViaKleros records the bidirectional mapping and refunds
 *      the overpayment to the caller.
 *   4. rule() can only be called by klerosArbitrator (reverts
 *      NotKlerosArbitrator otherwise).
 *   5. rule() with an unknown disputeId reverts UnknownDisputeId.
 *   6. rule() with ruling 1 routes 100/0 to buyer; ruling 2 routes
 *      0/100 to seller; ruling 0 routes 50/50; ruling > 2 reverts.
 *   7. The verdictHash stored for a Kleros verdict is
 *      keccak256("kleros:", disputeId) — distinguishable from
 *      self-arbiter verdicts in downstream indexers.
 *   8. Self-arbiter escrows cannot be routed through disputeViaKleros
 *      even if the caller attaches the fee (reverts NotAKlerosEscrow).
 *   9. A KLEROS escrow with a pending Kleros dispute cannot be
 *      routed again (reverts DisputeAlreadyCreated).
 *  10. Reentrancy: Kleros arbitrator cannot re-enter rule() during
 *      _resolve payout (inherited ReentrancyGuard on _resolve).
 *
 * Once the real EscrowV1 amendment lands, the tests below should be
 * ported from sketch to concrete — pointing at the real
 * `EscrowV1` instance under test and using a mock
 * `IArbitratorV2` that logs calls and accepts a scripted disputeId.
 */

// import "forge-std/Test.sol";
// import "../../src/EscrowV1.sol";
// import "../../draft/EscrowV1WithKleros.sol";
//
// contract MockKlerosArbitrator is IArbitratorV2 {
//     uint256 public nextDisputeId = 1;
//     uint256 public fee = 0.01 ether;
//
//     function setFee(uint256 newFee) external { fee = newFee; }
//
//     function arbitrationCost(bytes calldata) external view returns (uint256) {
//         return fee;
//     }
//
//     function createDispute(uint256, bytes calldata)
//         external
//         payable
//         returns (uint256)
//     {
//         require(msg.value >= fee, "underpay");
//         uint256 id = nextDisputeId++;
//         return id;
//     }
//
//     function giveRuling(address arbitrable, uint256 disputeId, uint256 ruling)
//         external
//     {
//         IArbitrableV2(arbitrable).rule(disputeId, ruling);
//     }
// }
//
// contract KlerosDraftTest is Test {
//     // ... see coverage targets 1–10 above.
//     // Each target is one testFn, each referencing either
//     // `vm.expectRevert(EscrowV1WithKleros.NotAKlerosEscrow.selector)`
//     // or a concrete event-match assertion.
// }
