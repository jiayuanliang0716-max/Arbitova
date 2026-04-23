# Multisig Arbiter Design (v0.1 draft)

Status: design draft. No code or Safe deployment yet.
Author: Arbitova / 2026-04-23.
Scope: the `arbiter` role on `EscrowV1` currently deployed to Base
Sepolia at `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`.

---

## The trust problem this addresses

Today the `arbiter` on `EscrowV1` is a single EOA controlled by
Arbitova. The `resolve(uint256 id, uint16 buyerBps, uint16
sellerBps, bytes32 verdictHash)` function can only be called by that
address. This means:

1. The arbiter can split disputed funds in any ratio, up to 10_000
   bps to either party (the contract does not cap split shapes).
2. The arbiter cannot sweep funds to a third address — on `resolve`,
   the contract computes `toBuyer` and `toSeller` and pays them
   directly. Only the split shape is under arbiter control.
3. The arbiter's private key is a single point of failure. If the
   key is compromised, an attacker can split every disputed escrow
   100/0 in favor of an account they control as either party.

(3) is the immediate exposure. (1) is a design constraint that's
acceptable for a known-role arbiter but not for mainnet scale.

## Proposed v0.1 change

Replace the single-EOA arbiter with a **3-of-5 Safe multisig**. No
contract changes — the arbiter `address` on `EscrowV1` simply
becomes the Safe address. `resolve` is called via a Safe
transaction that clears the 3-of-5 threshold.

The contract already accepts "whoever calls from the arbiter
address" — a Safe's `execTransaction` fits this interface
transparently. No redeploy.

### Signer set (proposed)

Five signers. Three are required to execute:

| # | Role | Custody |
|---|---|---|
| 1 | Arbitova operations (primary) | Hardware wallet, daily-use. |
| 2 | Arbitova operations (backup) | Hardware wallet, cold storage. |
| 3 | Third-party legal counsel | External, subject to engagement letter. |
| 4 | Arbitova founder personal | Separate hardware wallet from (1)/(2). |
| 5 | Rotating external keyholder | Board member or advisor; annual rotation. |

Rationale for 3-of-5 and not 2-of-3:
- 2-of-3 is too brittle: losing one key drops us to single-signature, which is what we're trying to escape.
- 5-of-7 is too high-friction for a weekly dispute cadence.
- 3-of-5 lets two Arbitova-controlled signers plus one external signer execute. It also lets three non-Arbitova signers coordinate if Arbitova itself is compromised, which is the case that matters.

### Off-chain verdict pipeline

The existing Claude-arbiter pipeline (confidence gate, below-0.7
escalates to human review) continues to produce the verdict. The
change is who signs it:

```
Dispute filed
  → Claude analyzes verificationURI + deliveryHash
  → outputs (buyerBps, sellerBps, confidence)
  → if confidence < 0.7: route to human review
  → once verdict finalized:
    → Safe transaction built with resolve() payload
    → signer 1 + signer 2 countersign
    → external signer reviews verdict summary + cosigns
    → execTransaction submitted
```

The verdict payload includes `verdictHash` — an IPFS CID of the
full verdict rationale. Public verification remains unchanged.

## What this does NOT give us

- **Not decentralized.** A multisig controlled by Arbitova + our
  counsel + an advisor is still five named people. Actually
  decentralized dispute resolution is a separate Phase 6 research
  track (UMA Optimistic Oracle as an opt-in appeal layer on a future
  V2 contract — see docs/decisions/M-0-arbiter-architecture-v1.md
  for why Kleros v2 was ruled out for v1).
- **Not audit-complete.** Changing the arbiter address does not
  change the contract. But it doesn't remove the need for a full
  `EscrowV1.sol` audit before mainnet.
- **Not free.** Safe execution costs gas. Arbiter operations
  budget should account for ~3x per-dispute gas on Base L2 (signer
  nonce coordination + execTransaction).

## Migration plan (testnet)

1. Deploy new Safe on Base Sepolia with the five signers above.
2. On a staging `EscrowV1` instance (or a redeploy; cheaper on
   Sepolia), set `arbiter = <Safe address>`.
3. Run three synthetic disputes end-to-end:
   - One happy-path confidence-0.9 dispute: Safe co-signs, resolves
     cleanly.
   - One low-confidence dispute escalated to human review: human
     verdict cleared, Safe co-signs, resolves.
   - One intentional signer-down scenario: third-party signer
     unavailable, verify 2 of 5 cannot execute, 3 of 5 can once
     backup cosigns.
4. Document the signer SOP: who signs what, when, and the emergency
   revocation path.

## Migration plan (mainnet — gated)

Mainnet deployment is separately gated on:

- **Full audit of `EscrowV1.sol`.** Must cover: reentrancy paths
  through USDC transfer hooks, state machine invariants, fee math
  edge cases (1 bps losses), gas griefing on `escalateIfExpired`.
- **Signer rotation tooling**: documented, tested, rehearsed.
- **Published SOP**: public-facing doc describing who the signers
  are (by role, not name if signers request privacy) and how
  verdicts are produced.

Absent any of the above, the protocol stays on Sepolia. There is
no rush.

## Open questions

1. **Do we want a `pendingArbiter` / timelock on arbiter change?**
   Currently `setArbiter` is owner-controlled and immediate. A
   timelock would let users notice an arbiter swap before it takes
   effect. Worth a contract change.
2. **Gas cost budget per dispute.** Need to measure real Safe
   execTransaction cost on Base L2 vs. our 2% resolve fee.
3. **What happens if a signer's key is lost?** Safe's owner-change
   flow requires the remaining 3-of-5 quorum. This works for lost
   keys but creates a race if 3 signers are compromised
   simultaneously. Acceptable for v0.1; revisit at mainnet.

## Related

- `docs/x402-adapter-spec.md` — x402 integration that uses this arbiter path on dispute.
- `docs/decisions/M-0-arbiter-architecture-v1.md` — v1 single-tier decision and why Kleros was ruled out; Phase 6 UMA OO research.
- `docs/transparency-policy.md` — per-case verdict publication + re-audit gate that makes multisig verdict scrutiny meaningful.
- Dev Log #019 "Positioning as Protocol" — mentions multisig arbiter as the next concrete reduction in single-arbiter trust.
