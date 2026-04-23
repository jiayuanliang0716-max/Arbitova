# Kleros v2 Integration Plan (v0.1 draft)

Status: plan only. No contract changes, no Kleros subcourt registration.
Author: Arbitova / 2026-04-23.
Audience: future-me, potential auditors, Kleros cooperative if they
find this file and want to sanity-check the approach.

---

## Why Kleros

The current `EscrowV1` deployment has a single-EOA arbiter: a Claude-
powered verdict engine with a 0.7 confidence gate, operated by
Arbitova. `docs/multisig-arbiter-design.md` proposes a 3-of-5 Safe
multisig as the next reduction in trust; that's an incremental
improvement, not a structural one. The multisig is still five named
people with Arbitova at the center.

Kleros v2 offers structural decentralization: disputes are routed to
pseudonymous jurors who stake PNK (the Kleros native token), rule on
the case, and receive/lose stake based on whether they voted with
the majority. No operator controls the outcome. No single multisig
can be coerced.

The goal is not to remove Arbitova's arbiter entirely — it's to
give users a **configurable arbiter per escrow**. Some disputes
belong in Kleros (adversarial counterparties, high stakes,
irreducible human judgment). Some belong with a fast Claude-
verdict arbiter (low stakes, clear delivery criteria, time-
sensitive). Let the market decide.

## Architecture sketch

`EscrowV1` today has one `arbiter` address. For Kleros support:

**Option A (minimal):** add a second arbiter slot
`klerosArbitrator`. `createEscrow` takes an enum selecting
`SELF_ARBITER | KLEROS`. Disputes in KLEROS-flagged escrows are
routed to the Kleros v2 arbitrator contract via `IArbitratorV2`.
Verdicts come back via a callback (`rule(disputeId, ruling)`) that
maps 1 → buyer win, 2 → seller win, 3 → split.

**Option B (maximal):** redeploy `EscrowV2` that takes an
arbitrator contract address at `createEscrow` time. Any ERC-792
arbitrator works. This is more flexible but requires a redeploy and
is orthogonal to the v0.1 goal.

v0.1 scope: **Option A.** No redeploy; add the Kleros path as a
second arbiter slot and a new state-transition path.

### New state machine diff

Existing `DISPUTED → RESOLVED` transition today only happens via
`arbiter.call resolve(...)`. With Kleros:

```
DISPUTED (SELF_ARBITER)  →  arbiter calls resolve(...)
                         →  RESOLVED

DISPUTED (KLEROS)        →  EscrowV1 calls klerosArbitrator.createDispute(2 rulings)
                         →  pays arbitration fee in ETH (or Kleros v2 equivalent)
                         →  waits for rule(disputeId, ruling) callback
                         →  callback routes ruling → splits funds → RESOLVED
```

`createDispute` is payable. The arbitration fee needs to come from
somewhere. Options:

1. Buyer pays upfront when flagging KLEROS at escrow creation.
   Locks a small ETH amount alongside the USDC. If no dispute, ETH
   refunds on `confirmDelivery`.
2. Loser pays at `dispute` time (whoever calls `dispute()` must
   attach the arbitration fee).
3. Split: whichever party calls `dispute` attaches the fee; on
   resolution, the winning party is reimbursed from the losing
   party's portion.

v0.1 proposes (2). Simplest, cleanest attribution.

### Callback handling

Kleros v2 calls back via `rule(uint256 disputeId, uint256 ruling)`
where ruling is 1..N. For a two-option dispute (buyer-win /
seller-win) we want:

- `ruling == 1` → buyer wins → `buyerBps = 10_000, sellerBps = 0`
- `ruling == 2` → seller wins → `buyerBps = 0, sellerBps = 10_000`
- `ruling == 0` → no ruling / refused → split 50/50 or hold

We maintain a `mapping(uint256 => uint256)` from Kleros disputeId
to our escrowId. `rule` can only be called by the Kleros
arbitrator contract; guarded by `require(msg.sender == klerosArbitrator)`.

## What this does NOT remove

- **Operator-arbiter escrows still exist.** Users who pick
  SELF_ARBITER at `createEscrow` time are still trusting Arbitova's
  Claude verdict + confidence gate + multisig cosign.
- **Liveness risk on Kleros.** If the Kleros jury pool has low
  participation, disputes could sit unresolved. This is well-
  documented; not our problem to fix, but worth flagging to users.
- **Cost on mainnet.** Kleros mainnet arbitration is not free. At
  mainnet, the arbitration fee could be comparable to the escrow
  value for small-dollar disputes. Probably SELF_ARBITER stays the
  default, and KLEROS is opt-in for high-stakes escrows.

## v0.1 deliverables

1. Contract: `EscrowV1` minor amendment adding `klerosArbitrator`,
   `IArbitratorV2` interface import, `createDisputeViaKleros`
   internal helper, `rule` callback. This is a contract change;
   redeploy on Sepolia.
2. Script: `DeployEscrowV1WithKleros.s.sol` takes the Kleros v2
   testnet arbitrator address as an env var.
3. SDK: extend `createEscrow` in JS + Python SDKs with an optional
   `arbiter: 'self' | 'kleros'` parameter. Backward-compatible —
   defaults to 'self'.
4. Docs: public page at `/architecture#arbiter-choice` explaining
   the trade-off and cost delta.

## Sequencing

This plan is downstream of:

- `EscrowV1` audit (required before any on-chain contract change)
- `ReputationV1` deployment decision (Kleros jurors should probably
  get their own Role tag in ReputationV1 — add later, not blocking)

This plan is upstream of:

- Mainnet deployment: Kleros v2 mainnet is the natural place to
  activate KLEROS routing; Sepolia is testing ground.

## Open questions

1. **Which Kleros v2 subcourt?** Kleros v2 supports multiple
   subcourts specialized by domain. Is there a "digital services"
   or "small claims" subcourt appropriate for agent-to-agent
   disputes? User to investigate before contract change.
2. **English-language bias.** Kleros jurors read case text. If most
   disputes involve multilingual agent payloads, jurors may
   struggle. Consider requiring English-only `verificationURI`
   content for KLEROS-arbitrated escrows.
3. **Partial rulings.** Kleros v2 may not support buyerBps /
   sellerBps at arbitrary granularity — rulings are typically
   discrete. v0.1 accepts this as a simplification: KLEROS escrows
   settle 100/0 or 0/100, not 60/40. Users needing partial splits
   pick SELF_ARBITER.

## What this plan intentionally leaves out

- Reputation import from Kleros. Jurors on Kleros have PNK staking
  history; whether that should influence reputation receipts is a
  separate design question.
- UI for choosing arbiter at escrow creation. The `/pay/`
  dashboard would need an arbiter selector. Out of scope for this
  doc.
- Legal framing around arbitration decisions. Kleros rulings are
  not legally binding courts; they're a market-based dispute layer.
  If real legal recourse becomes necessary, that's a separate
  question and not something a smart contract answers.
