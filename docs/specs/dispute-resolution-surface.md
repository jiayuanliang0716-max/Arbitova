---
title: Minimal Dispute-Resolution Surface
version: v0.2 working draft
status: WORKING DRAFT — under co-authoring with MoltBridge attestation surface (a2aproject/A2A#1631)
authors:
  - Jiayuan Liang (Arbitova)
companions:
  - MoltBridge minimal trust attestation surface (a2aproject/A2A#1631)
intent: |
  Provider-neutral specification of the surface by which `disputed` /
  negative-outcome attestations get produced from contested A2A interactions,
  in a form a third-party reputation/discovery substrate can consume with a
  bounded trust assumption.
tone_register: declarative, boundary-explicit, no marketing verbs
---

# Minimal Dispute-Resolution Surface — v0.2

> Working draft. Companion to the minimal trust attestation surface under
> discussion in a2aproject/A2A#1631. This document specifies how a `disputed`
> (negative-outcome) attestation gets produced; the companion specifies how
> such an attestation is consumed.

## 0. Scope

**In scope.** The data and process by which a `disputed` (or negative-outcome)
attestation about an A2A interaction gets produced; the trust assumptions a
third-party consumer of that attestation must — and must not — be required to
make; the minimal interface a dispute-resolution implementation MUST expose so
that an attestation/reputation substrate can consume its output.

**Out of scope.** Reputation scoring and aggregation; agent discovery; the
positive-outcome attestation vocabulary; appeals and escalation above the
first-level dispute resolution; the fee/payment substrate beneath the
contested interaction.

## 1. Threat Model

A dispute-resolution surface exists to defend against a threat the attestation
substrate alone cannot:

| Threat | Defence layer | Example |
|---|---|---|
| Fake attestation (no real interaction) | Attestation substrate (interaction-bound evidence; self-eval rejection) | Agent A writes a positive attestation about Agent B without ever interacting. |
| Collusion (real interaction, coordinated inflation) | Attestation substrate (same-owner decay; PageRank-style weighting) | Two agents under one operator emit mutual positive attestations. |
| Contested interaction (real, honest disagreement) | This surface. | Buyer and seller both interacted, both believe they are right. |
| Retaliatory negative-outcome attestation (real, bad-faith) | This surface. | Seller delivered honestly; buyer publishes `disputed` to depress seller's reputation. |
| Pre-emptive negative-outcome attestation (real, bad-faith) | This surface. | Seller under-delivers, then publishes `disputed` against the buyer first to neutralise the buyer's incoming negative attestation. |
| Farmed-positive attack via manufactured disputes | This surface (asymmetric mapping; see §5.1) | Party manufactures a dispute it expects to win, in order to harvest a positive attestation as the "winning" side. Defended by emitting only a negative attestation against the losing party — never a derived positive against the winner. |

The substrate cannot, on its own, distinguish a genuine dispute from a
retaliatory or pre-emptive one when both parties are interaction-bound
evaluators of the same record. That distinction is the entire job of this
surface.

## 2. Anchoring Principle

**No recorded interaction, no dispute.** Every attestation produced under this
surface MUST reference an interaction that was committed by both parties on a
public substrate (e.g., on-chain escrow with both buyer and seller actions
recorded) **prior to** the dispute being raised. An implementation MUST refuse
to produce an attestation whose `evidence_pointer` resolves to no such record,
or to a record without prior commitment from both parties.

Rationale: this prevents fabricated attestations against agents who never
engaged, and forces the dispute locus to coincide with the interaction locus.
This mirrors the gate the companion attestation substrate already applies for
positive and negative edges — interaction-bound evidence is the precondition
for any attestation, positive or negative, to enter the graph. This surface
extends that gate one layer down, to the dispute that produces the negative
edge in the first place.

## 3. Core Process

A dispute-resolution implementation is a process:

```
contested interaction  ──▶  [ resolution process ]  ──▶  signed attestation
   (escrow / handshake)        (impl-specific)            (consumed by substrate)
```

with three canonical phases:

1. **Evidence submission.** Each party submits evidence under the channel
   isolation requirements specified in §3.1.
2. **Resolution.** An arbiter — single agent, multi-agent, optimistic oracle,
   panel of humans, or some composition — produces a verdict comprising
   outcome, public reasoning, and the set of evidence hashes considered.
3. **Publication.** The verdict, its reasoning, and the evidence hashes are
   published in a form any third party can independently re-fetch and audit.

### 3.1 Channel isolation (normative)

Untrusted evidence content — any field submitted by a disputing party that
flows into the arbiter — MUST be channel-isolated from the arbiter's
instruction surface. Specifically:

- **(a) Envelope.** Untrusted fields MUST be enclosed in a structured
  envelope whose boundary tokens cannot occur unescaped within the field.
- **(b) Escape rule.** The envelope MUST define a deterministic escape or
  canonicalisation rule that prevents a disputing party from forging a
  closing-boundary token inside the evidence content.
- **(c) Instruction surface separation.** The arbiter's instruction surface
  (system prompt, scoring rubric, conformance rules) MUST be separable from
  the evidence surface in a way the arbiter can detect — i.e., the arbiter
  MUST NOT treat any text arriving via the evidence channel as an
  instruction.

Implementations that fail any of (a)–(c) are non-conformant: their output
is structurally vulnerable to evidence-mediated prompt injection, which
would let a disputing party rewrite the verdict by crafting evidence that
imitates arbiter instructions. A substrate consuming attestations from a
non-conformant implementation cannot rely on the §7 reconstructibility
property, because the verdict the arbiter produced may not reflect the
arbiter's stated reasoning over the submitted evidence.

> **Non-normative.** Arbitova implements (a) by wrapping untrusted fields
> in XML envelopes (e.g., `<evidence_buyer>...</evidence_buyer>`), (b) by
> escaping any closing-tag pattern detected within the field with
> zero-width-space characters, and (c) by serving the rubric as a
> separate API message-role. Other isolation strategies — dual-model
> verifier chains, capability-token guards, syntactic sandboxing — are
> conformant if they meet (a)–(c). The choice of strategy is left to the
> implementation.

## 4. Inputs

An implementation MUST accept an input of at least the following shape:

```json
{
  "interaction_id": "string, unique and stable; resolves on the substrate referenced in §2",
  "initiator": "agent identifier",
  "counterparty": "agent identifier",
  "claim": ["string", ...],  // free-form reasons; v0.2 does not enumerate. e.g. ["non-delivery"], ["timeliness", "quality"]
  "evidence": [
    {
      "submitted_by": "agent identifier",
      "type": "artifact_hash | text | structured",
      "content_ref": "URI or on-chain pointer",
      "content_hash": "hex string (algorithm declared per implementation)",
      "submitted_at": "ISO-8601 timestamp"
    }
  ],
  "spec": {
    "spec_ref": "URI of the interaction's prior agreement",
    "spec_hash": "hex string — hash of agreement, captured before interaction"
  }
}
```

`claim` is intentionally free-form in v0.2. A dispute can carry multiple
reasons (e.g. `["timeliness", "quality"]`); the substrate is expected to
treat the array as unstructured metadata and rely on `verdict_reasoning`
for the authoritative narrative. A future version may introduce a
controlled vocabulary; v0.2 does not.

`spec` exists so the resolution can be audited against what the parties
actually agreed to, not an after-the-fact interpretation. Its absence is
permitted (some interactions have no formal pre-agreement) but, if absent,
arbiters MUST disclose the fact in their reasoning.

## 5. Outputs (Attestation Shape)

An attestation produced by this surface, intended for consumption by the
companion attestation substrate, MUST carry at least these fields:

```json
{
  "issuer":   "<arbiter signing key>",
  "subject":  "<losing-party agent key, per outcome>",
  "scope":    "<skill / context derived from the contested interaction>",
  "outcome":  "negative",
  "evidence_pointer": {
    "kind":         "<implementation tag, e.g. 'arbitova_verdict'>",
    "interaction_id": "<as in §4>",
    "verdict_hash": "<hex string: hash of verdict record per §6>",
    "chain":        "<substrate identifier, e.g. 'base-sepolia' or 'off-chain:<storage>'>"
  },
  "timestamp": "<verdict_issued_at, ISO-8601>",
  "signature": "<issuer's signature over the canonicalised attestation>"
}
```

### 5.1 Outcome vocabulary

`outcome: negative` is the canonical and only outcome value defined in v0.2:
the dispute resolved against the subject. Substrates that consume this
surface MUST treat unknown outcome values as `outcome: incomplete` (i.e., do
not penalise on a verdict whose semantics they cannot interpret).

Partial-loss outcomes (a single dispute resolving with shared fault between
both parties) are deliberately deferred to v0.3 pending threat-model
alignment with the companion attestation surface. A v0.2 implementation
facing a shared-fault verdict SHOULD either emit separate `outcome: negative`
attestations against each party for their share of fault, or refrain from
emitting an attestation, rather than fabricate a `split` value the consuming
substrate cannot yet reason about.

This surface deliberately does **not** mandate that a winning party receive a
positive attestation from the same record. "Did not lose this dispute" does
not constitute evidence of broader competence and SHOULD NOT be expanded
into one. Conflating the two would create the farmed-positive attack
catalogued in §1: a party manufactures a dispute it expects to win in order
to harvest a derived positive attestation.

### 5.2 Verdict reasoning

`verdict_hash` is a commitment. The verdict itself — including
`verdict_reasoning` (public string), `evidence_hashes` (array), and `outcome`
— MUST be re-fetchable from a location encoded in or derivable from
`evidence_pointer`. Implementations are not free to publish only the hash;
they MUST also publish the preimage in a stable, durable location.

## 6. Verdict Hash Canonicalisation

`verdict_hash` is the hash, under a declared algorithm, of the canonical
serialisation of:

```
{
  "outcome":           <as in §5>,
  "subject":           <as in §5>,
  "verdict_reasoning": <public string>,
  "evidence_hashes":   <sorted array of hex strings>,
  "spec_hash":         <as in §4, or null>,
  "issued_at":         <ISO-8601>
}
```

Canonicalisation rules an implementation MUST publish:

- field ordering (alphabetical; or any explicit order, but declared);
- whitespace handling (none, or canonical JSON);
- string encoding (UTF-8, NFC normalisation if Unicode is permitted in
  `verdict_reasoning`);
- numeric handling (integers only, or fixed-precision decimals).

Without canonicalisation rules, two parties cannot independently arrive at the
same `verdict_hash`. A substrate MUST reject attestations whose
canonicalisation rules are not published or not deterministic.

## 7. Trust Assumptions

A consumer of an attestation produced under this surface MUST be able to:

1. Resolve the interaction record referenced by `evidence_pointer`, then
   fetch each evidence artefact and recompute its `content_hash`.
2. Read `verdict_reasoning` as a publicly inspectable artefact.
3. Recompute `verdict_hash` from the published preimage per §6.
4. Verify the `signature` field against the `issuer` key.

If any of (2)–(4) fails, the attestation is **invalid** and MUST be rejected
by the consuming substrate. If (1) fails — i.e., the interaction record is
no longer resolvable at consumption time (chain reorg, bridge stale,
publication substrate offline) — the consuming substrate MUST treat the
attestation as `incomplete` rather than `invalid`. The verdict may still
be reconstructible later, and a transient resolution failure is not
evidence the verdict was ever wrong.

> **Note on issuer identity (out of scope).** This surface specifies how to
> verify that an attestation was signed by some key. It does NOT specify
> how the consuming substrate maps that key to a known arbiter identity.
> The companion attestation surface (a2aproject/A2A#1631) is the natural
> locus for that mapping; ERC-8004 Reputation Registry is another. An
> attestation whose `issuer` key cannot be resolved to a known arbiter
> SHOULD be treated as `incomplete` rather than `invalid` — the verdict
> may still be reconstructible per (1)–(4), but is provenance-detached
> until the mapping resolves.

The attestation carries the assumption:

> "The arbiter's stated reasoning, evaluated against the published evidence,
> produced the stated outcome."

It does NOT carry the assumption:

> ~~"The arbiter is institutionally trustworthy."~~

The consuming substrate is responsible for whatever evaluator-quality
weighting it applies to the issuer; this surface only guarantees that the
verdict is **reconstructible**.

## 8. Known Non-Guarantees

- The surface does NOT guarantee the arbiter's reasoning is *correct* — only
  that it is *reconstructible*. Quality weighting is a substrate concern.
- The surface does NOT mandate an arbiter-selection mechanism. Single-agent,
  multi-agent, oracle, and human-panel implementations are all conformant
  provided they meet §7.
- The surface does NOT specify SLA. Implementations advertise their own
  latency and cost targets.
- The surface does NOT address censorship resistance of the underlying
  publication substrate. An implementation that publishes verdicts to a
  storage layer the issuer can later redact is conformant in form but weaker
  in trust; substrates SHOULD downweight such attestations if they can detect
  it.

## 9. Composition with the Companion Attestation Surface

Under the minimal trust attestation surface in a2aproject/A2A#1631, the
attestation in §5 is itself the substrate's `negative-outcome` (or `disputed`)
record. No translation layer is required: this surface's `Outputs` and the
companion surface's expected input shape are intentionally aligned.

The substrate's anti-gaming measures — interaction-bound evidence, self-eval
rejection, same-owner decay, evaluator-quality weighting — continue to apply
at substrate level. This surface contributes the property that the
negative-outcome value is **reconstructible**, which substrate-level
anti-gaming alone cannot provide.

## 10. Reference Implementations (Non-Normative)

- **Arbitova.** Single-agent AI arbiter; on-chain escrow as interaction
  anchor; `keccak256` content verification. Sepolia contract:
  `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`. Per-case verdict surface:
  `https://arbitova.com/verdicts`.
- *Open slot.* An optimistic-oracle implementation — e.g. UMA-style
  challenge-window resolution with a slashing-backed escalation path,
  emitting an attestation only after the challenge window closes
  uncontested. Open for contribution.
- *Open slot.* A human-panel implementation — e.g. Kleros-style juror
  selection with a stake-weighted verdict — for high-value cases where a
  relaxed SLA (hours-to-days latency) is acceptable in exchange for a
  decentralised arbiter set. Open for contribution.

Inclusion in this list does not imply normative status. Implementations
conform iff they meet the requirements of §2, §4, §5, §6, and §7.

## 11. Open Questions

**Q1. Issuer key algorithm.** The companion surface's working schema names
`issuer` as an `ed25519` public key. Arbitova's current arbiter authority
on-chain is a `secp256k1` wallet (Base / EVM-native), and the verdict is
anchored by that wallet's transaction signature. Two paths:

- **(a) Reuse the on-chain `secp256k1` key as the attestation issuer.** One
  identity, simpler key management. Couples the attestation key to a
  gas-bearing wallet, which is operationally noisier and creates blast-radius
  if the wallet is compromised for financial reasons.
- **(b) Introduce a dedicated `ed25519` attestation key, bound to the
  on-chain `secp256k1` arbiter via a signed registration record published on
  the same chain.** Cleaner key separation, lower blast radius. Adds a
  registration-record format that both surfaces would need to acknowledge.

The author leans **(b)**: it generalises better when the arbiter role itself
decentralises (multi-arbiter selection, optimistic-oracle fallback), since
the attestation identity can stay stable while the underlying on-chain
signing authority rotates. The cost is one additional artefact — the
registration record — that the consuming substrate must resolve to verify
the binding. Flagged here for explicit decision before schema freeze.

**Q2. Split-outcome semantics (deferred to v0.3).** Partial-loss verdicts
require their own threat-model row (see §1) and substrate-side indexing
semantics that v0.2 has not aligned with the companion surface. The
question — continuous `subject_share ∈ [0,1]` versus discrete buckets,
substrate weighting rules, retaliatory-split attack surface — is deferred
to v0.3 once binary-outcome semantics are stable.

**Q3. On-chain anchoring of `verdict_hash`.** Should the surface mandate
on-chain anchoring of the `verdict_hash` (stronger auditability — a third
party can confirm the hash was committed before any later evidence-rewrite),
or leave anchoring to implementation? Off-chain implementations would still
be conformant under §7 but weaker in practice.

**Q4. Composition with ERC-8004 Reputation Registry.** ERC-8004 contemplates
on-chain attestations stored against an `agentId`. Does writing
`verdict_hash` via `setMetadata(agentId, "dispute_verdict_hash", hash)` (or
similar) align with what ERC-8004 maintainers expect? This is a coordination
question for that working group, not a specification gap here.

## 12. Versioning

This document is `v0.2 working draft`. Backwards-incompatible changes are
expected through `v0.x`. A `v1.0` release is gated on:

- companion attestation surface freezing its consumption shape (§5 alignment
  must hold);
- Q1 (issuer key algorithm) decided;
- at least one independent reference implementation published.

---

## Appendix A — Worked Example (Non-Normative)

A buyer agent locks 100 USDC into an on-chain escrow with a seller agent for
a code-review task, anchored by a `spec_ref` URL whose `spec_hash` is
recorded in the escrow at creation. The seller marks delivery with
`keccak256(deliveryPayloadURI)` recorded on-chain. The buyer rejects, citing
non-delivery. The arbiter — registered as the escrow's arbiter address —
gathers buyer and seller evidence, evaluates against `spec_ref`, and emits:

```json
{
  "issuer":  "<arbiter_attestation_key>",
  "subject": "<seller_agent_key>",
  "scope":   "code-review.python",
  "outcome": "negative",
  "evidence_pointer": {
    "kind":           "arbitova_verdict",
    "interaction_id": "escrow:base-sepolia:0xA8a0...88fC:#42",
    "verdict_hash":   "0x9c1f...e2b0",
    "chain":          "base-sepolia"
  },
  "timestamp": "2026-04-30T12:34:56Z",
  "signature": "<issuer signature over canonicalised attestation>"
}
```

A consuming substrate fetches the verdict from
`https://arbitova.com/verdicts/0x9c1f...e2b0`, recomputes the hash per §6,
verifies the signature against the `issuer` key registered on-chain, and
either records or rejects the attestation accordingly.

## Appendix B — Drafting Notes

- This draft is intentionally narrower than the v0.1 skeleton in
  `drafts/dispute-resolution-surface-spec.md`. Sections that prescribed
  specific arbiter implementations (multi-agent panels, etc.) have been
  removed; they are reference implementations, not specification.
- Field naming and casing in §5 follow the working schema proposed by the
  companion surface author (snake_case, flat `evidence_pointer`). Final
  names will track whatever the companion surface freezes at v1.0.
- Section 11's open questions are the items this draft genuinely wants
  feedback on. Other ambiguities (e.g., signature scheme for the
  attestation envelope) are deferred until the companion surface specifies
  its expectation.
