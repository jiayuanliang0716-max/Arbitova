# Arbiter operations runbook

Status: **v0.2 — amended 2026-04-24**
Scope: the internal SOPs that operationalize commitments made in
`docs/transparency-policy.md`. Other ops SOPs (key rotation,
incident response, mainnet deploy) will accrete into this file as
they are written.

---

## Amendment note (2026-04-24)

The previous v0.1 of this runbook (`git log`-inspectable on
2026-04-23) contained a §1 "Re-audit workflow" SOP covering
nightly sampling, reviewer assignment, disagreement definition,
the `arbitration_reaudits` data model, and the rolling-30
gate monitor — about 170 lines of operational detail.

That section has been removed, together with the underlying
transparency-policy commitment it operationalized. Rationale is
documented in the transparency policy's amendment log and in dev
log #023. The short version: the re-audit SOP required a second
operator Arbitova does not currently staff, so the commitment
was scoped down rather than kept aspirational.

If a re-audit program is re-introduced in a future policy
version, the SOP will be re-drafted at that point — with staffing
attached to the proposal, not bolted on after.

---

## 1. (reserved) Key rotation

Outline only; detailed SOP accretes here once the 3-of-5 Safe is
live and we've rehearsed a rotation on Sepolia. For now see
`docs/multisig-arbiter-design.md` §"Migration plan (testnet)".

## 2. (reserved) Incident response

Outline only; to be written after the first Phase 4 Sepolia
incident exercise. Contract-level escape hatch is `Pausable`
(maintained in `contracts/src/EscrowV1.sol`), covered by the
security checklist.
