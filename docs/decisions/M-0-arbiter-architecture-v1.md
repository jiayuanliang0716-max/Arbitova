# M-0: Arbiter Architecture for v1 — Single-Tier, No Kleros Appeal

Status: **DECIDED 2026-04-23**
Supersedes: Kleros two-tier design (`docs/two-tier-arbitration-design.md`)
Blocks/unblocks: removes Phase 3 entirely; collapses M-1 and M-6; reshapes M-2

---

## The decision

Arbitova v1 mainnet ships as a **single-tier** arbitration system:
Arbitova's AI pipeline (Claude Haiku ×3 or ensemble) produces a
verdict. A 3-of-5 Safe multisig signs the `resolve` transaction on
the escrow contract. **There is no appeal path. The Arbitova ruling
is final on-chain.**

No Kleros. No UMA. No external arbitrable layer of any kind, for v1.

---

## Why we ruled out Kleros

The M-1 bond-economics brief surfaced a fact that had been latent
in the design:

> Kleros v2 arbitration fees on Base are ~$60 per case (protocol
> minimum, not configurable by us).

For an A2A commerce market targeting microtransactions (median
escrow size we expect: $10–$100), a $60 arbitration floor means
the appeal path is **economically unreachable for the majority of
our volume.** The "two-tier arbitration" brand claim would be true
only for escrows over a threshold (proposed $100), which means
for the 60–80% of expected traffic below that threshold, there is
no meaningful appeal — just a UX checkbox that doesn't open.

Secondary concerns:

1. **Latency.** Kleros v2 rulings take 5–14 days. A2A dispute
   resolution in that time window is substantially slower than
   real-world e-commerce norms (1–3 days).
2. **Juror cultural fit.** Kleros's juror pool is trained on
   DeFi, prediction-market, and crypto-native disputes. Software
   delivery acceptance (the majority of A2A disputes) is a genre
   Kleros jurors are not selected for. Quality of ruling on our
   case types is unknown and we have no cheap way to validate it
   pre-launch.
3. **Contract surface cost.** Integrating Kleros adds ~400 lines
   of Solidity, a Kleros-aware indexer, bond-accounting logic,
   ruling callback handlers, and 90-day fallback code. All of
   this is code we'd audit and maintain for a capability that
   only a minority of our traffic can actually reach.

The cost/benefit doesn't clear. We chose to reconsider.

---

## What we ruled out instead

### UMA Optimistic Oracle

**UMA would be a better technical fit for our market:** ~$10–20
per case, 24–48h resolution, token-aligned jurors. Pencils out
economically for $50+ escrows.

**Why not for v1:** we have not implemented UMA, have not tested
it on Base, have no data on its juror-pool activity for our case
types, and have no production experience with it. Shipping an
appeal layer we haven't exercised is a new class of risk. UMA is
a **Phase 6 research item**, not a v1 integration.

### Private appellate panel

**Why not:** a hand-picked group of "community arbitrators" is
not meaningfully more decentralized than the Arbitova multisig
itself. It would be theater. If we can't ship real
decentralization, we shouldn't pretend.

### Wait and research before shipping v1

**Why not:** Arbitova has been in development for six months and
has zero paying users. We need to ship v1 and learn from real
disputes, not prolong architecture decisions indefinitely in
search of an optimal first version.

---

## What ships in v1

| Component               | v1 choice                                          |
|-------------------------|----------------------------------------------------|
| First-instance arbiter  | Arbitova AI pipeline (Claude-based ensemble)       |
| On-chain signer         | 3-of-5 Safe multisig                               |
| Appeal path             | **None.** Ruling is final on-chain.                |
| SLA for ruling          | < 24h from dispute filing (internal target)        |
| Confidence gate         | Escalate to human review below 0.60 (LOW) or below 0.75 with split votes (SPLIT) |
| Transparency            | Quarterly public report (see M-2 revised)          |
| Escape hatch            | Contract-level `Pausable` (already shipped in M-7) |

The escrow contract `EscrowV1` (already on Sepolia at
`0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`) already supports
exactly this model. **No contract changes required.** This is
the core reason the decision is low-cost: we're not undoing
work; we're committing to the architecture already deployed.

---

## Trade-offs we are accepting, out loud

### 1. Regulatory posture is weaker than two-tier would have been

**Two-tier framing:** "We render first-instance judgment; a
neutral third party reviews on appeal."
**Single-tier framing:** "We render final judgment on disputes
arising from escrows we hold."

The single-tier framing is closer to how money transmitters and
consumer-arbitration providers are regulated in the US. We do
not have a legal opinion on what exact classification this
triggers. **This is Phase 5 (legal primer) work and cannot be
assumed to be free.**

What we can say: the escrow contract remains non-custodial in
the technical sense (we don't sign routine payouts, buyer and
seller control their own funds until dispute), and disputes are
adjudicated by a multisig in which Arbitova holds 3 of 5 keys
(the remaining 2 can be seeded with trusted independent
signers). The exact legal framing needs counsel.

### 2. Brand claim "decentralized appeal" is off the table

Homepage, architecture page, and marketing material that said
or implied "Kleros appeal" or "decentralized appeal" need to be
rewritten. The honest v1 claim is:

> "AI-first arbitration for agent-to-agent commerce. Disputes
> are resolved by Arbitova's AI pipeline and signed on-chain by
> a 3-of-5 multisig. We publish a quarterly transparency report
> on our ruling accuracy and commit to a public root-cause
> review if our internal audit rate exceeds a threshold."

That is a weaker claim than "AI-first arbitration with
decentralized appeal." It's also the claim we can defend.

### 3. No reversal-rate signal

The two-tier design's strongest internal feedback loop was the
reversal rate — Kleros telling us when we were wrong. Without
it, we have to manufacture our own quality signal (see M-2
revised: internal audit cadence).

### 4. Reputation concentration risk

If a high-profile Arbitova ruling is widely perceived as wrong,
there is no escape valve. A losing counterparty cannot point to
"but Kleros can review this." They can only point to the
quarterly transparency report and — if relevant — a `Pause` of
the contract by our ops team.

We accept this. It's honest: we are asking users to trust our
ruling, and if we are wrong, we own it publicly.

---

## The Phase 6 roadmap commitment

We state publicly that:

1. We will research UMA Optimistic Oracle on Base in Phase 6
   (post-first-100-disputes).
2. If UMA pencils out on actual Arbitova traffic data, we will
   propose an appeal path as an optional upgrade to the escrow
   contract. This would be a **new version** of the contract
   (V2); v1 escrows remain single-tier forever.
3. The research report itself will be published whether or not
   we adopt UMA.

This commitment exists so that "single-tier for v1" is not the
same as "single-tier forever."

---

## What this unblocks

- **Phase 3 disappears.** M-1 (bond economics) and M-6 (bond
  currency) are moot — no bond. M-2 survives in a reshaped
  form (transparency of our own pipeline, not of a
  reversal-to-Kleros rate).
- **Phase 4 Sepolia deploy** no longer needs `EscrowV1Appeal.sol`
  or Kleros integration. The already-deployed `EscrowV1` is
  sufficient. We can move to mainnet-preparation as soon as
  multisig signers are confirmed and the legal primer is done.
- **Docs collapse.** `two-tier-arbitration-design.md`,
  `kleros-v2-integration-plan.md`, and two of the three M-n
  briefs are marked deprecated. The total doc surface Arbitova
  maintains shrinks noticeably.

---

## What this still doesn't resolve

- **M-2 revised** (internal audit transparency): how do we
  publish ruling-quality data when there's no independent
  reviewer to compare against? Requires a new brief.
- **Multisig signer list** (Y2 #4): unchanged blocker.
- **Regulatory framing** (C-5 / Phase 5 legal primer):
  unchanged blocker.
- **Pimlico paymaster budget** (Y2 #3): unchanged blocker.

---

## Decision record

- **Decision:** v1 ships single-tier. Kleros is not integrated.
- **Date:** 2026-04-23
- **Decider:** founder
- **Reason:** $60/case Kleros floor is a specification mismatch
  with A2A microtransaction market. Cost/benefit doesn't clear
  for v1.
- **Commitment:** Phase 6 UMA research, published regardless
  of adoption outcome.
- **Reversible?** Yes. V2 of the escrow contract can add an
  optional appeal path. V1 escrows remain as shipped.
