# A2A Escrow Protocol — Request for Comments v0.1

| Field | Value |
|---|---|
| Status | **Draft** |
| Version | `0.1.0` |
| Last updated | 2026-04-22 |
| Authors | Arbitova ([arbitova.com](https://arbitova.com)) |
| Reference impl | [EscrowV1.sol](https://github.com/jiayuanliang0716-max/Arbitova) |
| Discussion | [GitHub Discussions](https://github.com/jiayuanliang0716-max/Arbitova/discussions) |
| License | CC-BY-4.0 (this spec) · MIT (reference impl) |

> This document is an open standard proposal. Fork it, implement it, extend it. The goal is not a single canonical implementation but a shared vocabulary so two independently-built agents can transact with the same escrow semantics.

---

## Abstract

Autonomous agents that transact on behalf of humans need a way to exchange value without trusting each other. This document specifies **A2A Escrow Protocol v0.1** — a minimal, non-custodial, on-chain escrow with a well-defined arbitration interface for disputes.

The protocol covers:
- An on-chain state machine for escrow lifecycle
- A schema for machine-readable acceptance criteria (`verificationURI`)
- An off-chain arbiter interface with published verdict format
- A canonical event log so third-party indexers can agree on state

An Arbitova-operated reference implementation runs on Base (Ethereum L2) using Circle USDC.

---

## 1. Motivation

### 1.1 The problem

An AI agent acting for Alice wants to buy a deliverable — an API call's output, a dataset, a code review, a compute job — from an agent acting for Bob. Neither agent trusts the other. The humans behind them may never meet.

Existing solutions are inadequate:

- **Pre-pay**: buyer bears 100% counterparty risk.
- **Post-pay / invoice**: seller bears 100% counterparty risk.
- **Marketplace custody**: works at human speeds (dispute forms, email support); agents transacting at machine speed can't wait days.
- **Pure on-chain automation**: can't judge "was this delivery good?" when acceptance is subjective.

The missing primitive: **deterministic escrow with a well-defined human-or-AI-in-the-loop arbiter**, exposed as a standard interface agents can speak.

### 1.2 Why a standard

If every agent framework builds its own escrow, three bad things happen:

1. Cross-framework commerce is impossible — a CrewAI seller can't trivially accept from a LangGraph buyer.
2. Every escrow has a new security surface; auditing doesn't compound.
3. Disputes have no precedent database; each arbiter invents policy from scratch.

A shared spec with multiple conforming implementations solves all three.

### 1.3 Non-goals

- This spec does **not** define a reputation system, a discovery mechanism, or an agent identity standard. Those are layers above.
- This spec does **not** mandate a specific chain, token, or arbiter implementation.
- This spec does **not** replace KYC, AML, or fiat on-ramps.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Buyer** | The party sending funds into escrow |
| **Seller** | The party delivering the agreed artifact |
| **Arbiter** | A party (human, multi-sig, or agent) empowered to resolve disputes |
| **Escrow** | A single on-chain record tracking one transaction |
| **verificationURI** | Off-chain URI pointing to machine-readable acceptance criteria |
| **deliveryHash** | Hash committing the seller's delivery artifact |
| **Verdict** | Signed record of an arbiter's dispute decision |
| **Review window** | Period during which buyer may confirm or dispute after delivery |
| **USDC** | The primary settlement asset in the reference implementation |

Key words **MUST**, **SHOULD**, **MAY** follow [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119).

---

## 3. Architecture Overview

### 3.1 State machine

```
                      ┌─────────┐
                      │ CREATED │── escalateIfExpired ──▶ (DISPUTED)
                      └────┬────┘
           cancel/expire   │   seller markDelivered
                  ◀────────┤
                           ▼
                      ┌───────────┐
          ┌────────── │ DELIVERED │────────┐
          │           └─────┬─────┘        │
   buyer confirmDelivery    │    buyer dispute
          │                 │              │
          ▼                 ▼              ▼
     ┌──────────┐     ┌───────────┐    ┌──────────┐
     │ RELEASED │     │ CANCELLED │    │ DISPUTED │
     └──────────┘     └───────────┘    └────┬─────┘
                                            │  arbiter resolve
                                            ▼
                                      ┌──────────┐
                                      │ RESOLVED │
                                      └──────────┘
```

Six terminal or transitional states:

| State | Meaning |
|---|---|
| `CREATED` | Funds locked. Awaiting delivery. |
| `DELIVERED` | Seller claims delivery. Awaiting buyer review. |
| `RELEASED` | Buyer confirmed. Seller paid (minus fee). |
| `CANCELLED` | Delivery window expired without delivery. Buyer refunded. |
| `DISPUTED` | Buyer rejected. Arbiter notified. |
| `RESOLVED` | Arbiter decided the split. Funds distributed. |

### 3.2 Roles

- **Buyer** and **Seller** are addresses on the underlying chain. No registration.
- **Arbiter** is a single configured address (or multi-sig) known at contract deploy time. Implementations MAY support arbiter rotation via governance.
- **Indexer** is any observer of the event log. A conforming indexer can reconstruct every escrow's full history from events alone.

---

## 4. Escrow Contract Interface

A conforming on-chain implementation **MUST** expose the following surface. Function signatures are given in Solidity ABI form.

### 4.1 Data structures

```solidity
enum State { CREATED, DELIVERED, RELEASED, DISPUTED, RESOLVED, CANCELLED }

struct Escrow {
    address buyer;
    address seller;
    uint256 amount;             // in settlement token's smallest unit
    uint64  deliveryDeadline;   // unix seconds
    uint64  reviewDeadline;     // unix seconds, set at markDelivered
    uint64  reviewWindowSec;    // configured at create time
    State   state;
    bytes32 deliveryHash;       // set at markDelivered
    string  verificationURI;    // set at create time, immutable
}
```

### 4.2 Required methods

| Method | Callable by | Precondition |
|---|---|---|
| `createEscrow(address seller, uint256 amount, uint64 deliveryWindowSec, uint64 reviewWindowSec, string verificationURI) returns (uint256 id)` | buyer | token.approve(contract, amount) |
| `markDelivered(uint256 id, bytes32 deliveryHash)` | seller | state == CREATED |
| `confirmDelivery(uint256 id)` | buyer | state == DELIVERED |
| `dispute(uint256 id, string reason)` | buyer | state == DELIVERED, within reviewDeadline |
| `cancelIfNotDelivered(uint256 id)` | buyer | state == CREATED, past deliveryDeadline |
| `escalateIfExpired(uint256 id)` | anyone | state == DELIVERED, past reviewDeadline |
| `resolve(uint256 id, uint256 toBuyer, uint256 toSeller, bytes32 verdictHash)` | arbiter | state == DISPUTED |

Implementations **MUST** enforce the precondition column. Implementations **MAY** add methods beyond this set; conformance is about behavior on the required set.

### 4.3 Fee parameters

```solidity
function releaseFeeBps() view returns (uint16);   // fee on confirmDelivery
function resolveFeeBps() view returns (uint16);   // fee on arbiter resolve
```

Fees are denominated in basis points (bps = 1/100th of 1%) on the escrow `amount`. In the Arbitova reference implementation `releaseFeeBps = 50` (0.5%, happy-path) and `resolveFeeBps = 200` (2%, disputed path). The resolve fee comes out of the loser's share.

### 4.4 Required events

```solidity
event EscrowCreated(
    uint256 indexed id,
    address indexed buyer,
    address indexed seller,
    uint256 amount,
    uint64 deliveryDeadline,
    string verificationURI
);
event Delivered(uint256 indexed id, bytes32 deliveryHash, uint64 reviewDeadline);
event Released(uint256 indexed id, uint256 toSeller, uint256 fee);
event Disputed(uint256 indexed id, address by, string reason);
event Cancelled(uint256 indexed id);
event Resolved(uint256 indexed id, uint256 toBuyer, uint256 toSeller, uint256 feePaid, bytes32 verdictHash);
```

Implementations **MUST** emit these events on each corresponding state transition. Indexers rely on this for deterministic replay.

---

## 5. Verification URI Schema

The `verificationURI` field at escrow creation **SHOULD** point to a JSON document conforming to [arbitova-spec-v1](../public/schemas/arbitova-spec-v1.json). This gives:

- Sellers a machine-readable definition of "done"
- Arbiters a common reference when adjudicating
- Indexers a basis for categorizing escrows

### 5.1 Minimum document

```json
{
  "version": "arbitova-spec-v1",
  "mode": "manual",
  "acceptance": {
    "description": "Seller returns JSON transcription of audio file at audio.example.com/clip.wav within 24 hours. Accuracy > 95% word-error rate measured against ground truth."
  }
}
```

### 5.2 Modes

**`manual`** — Prose acceptance only. Human or LLM-judge evaluates.

**`programmatic`** — Adds a `check` block with an HTTPS endpoint the buyer's verifier calls with `{escrowId, deliveryPayloadURI}`. Endpoint returns `{pass: bool, reasons: string[]}`. Enables fully automated happy-path confirms without a human in the loop.

### 5.3 Dispute hints

The optional `dispute` block lets the buyer signal arbiter preferences non-bindingly:

```json
"dispute": {
  "tieBreak": "split-50-50",
  "evidenceURIs": ["https://docs.example.com/original-requirement.pdf"]
}
```

Arbiters **SHOULD** read these but are **NOT** bound by them.

See [full schema](../public/schemas/arbitova-spec-v1.json) and [examples](../public/schemas/examples/).

---

## 6. Arbiter Interface

When an escrow enters `DISPUTED`, the arbiter must produce a decision. This spec defines the *format* of that decision, not who the arbiter is.

### 6.1 Evidence inputs

The arbiter **SHOULD** consider, in order:

1. The `verificationURI` document (what was promised)
2. The `deliveryHash` artifact dereferenced (what was delivered)
3. The dispute `reason` string emitted in `Disputed` event
4. Any `evidenceURIs` listed in the `dispute` block

### 6.2 Verdict format

Before calling `resolve(...)`, the arbiter **SHOULD** publish a verdict document off-chain (IPFS, Arweave, or HTTPS):

```json
{
  "version": "arbitova-verdict-v1",
  "escrowId": "1234",
  "chain": "base-mainnet",
  "contractAddress": "0x...",
  "issuedAt": "2026-04-22T10:30:00Z",
  "arbiter": "0xArbiterAddress...",
  "outcome": {
    "toBuyer": "3.00",
    "toSeller": "1.80",
    "fee": "0.20"
  },
  "reasoning": "Seller delivered JSON but timestamp accuracy was 80%, below the 95% threshold in the spec. Partial credit for valid format.",
  "evidence": [
    { "kind": "spec",     "uri": "..." },
    { "kind": "delivery", "uri": "..." },
    { "kind": "test",     "uri": "..." }
  ],
  "confidence": 0.82
}
```

### 6.3 Verdict hash

The `verdictHash` passed to `resolve(...)` **MUST** be `keccak256(canonical_json_bytes)` of the verdict document, where canonicalization follows [RFC 8785](https://datatracker.ietf.org/doc/html/rfc8785) (JCS).

This gives anyone the ability to verify a published verdict document matches the on-chain hash.

### 6.4 Confidence gate

The optional `confidence` field is a self-reported `[0, 1]` value. Implementations **MAY** require confidence > threshold (Arbitova's reference uses 0.6) or escalate to a higher-trust arbiter.

---

## 7. Reference Implementation

The Arbitova reference deployment:

- Contract: [EscrowV1.sol](https://github.com/jiayuanliang0716-max/Arbitova) — deployed at `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` on Base Sepolia (mainnet deploy in staged rollout)
- Settlement asset: Circle USDC
- Arbiter: Arbitova Arbiter v1, documented at [arbitova.com/arbiter](https://arbitova.com/arbiter), verdict log at [arbitova.com/verdicts](https://arbitova.com/verdicts)
- Test suite: 66 unit + integration tests, all passing
- SDKs: `@arbitova/sdk@^3` (npm, JS/TS), `arbitova[path_b]` (PyPI, Python)
- MCP server: `@arbitova/mcp-server@^4` exposing the six on-chain operations as MCP tools
- Demo: [A2A demo repo](https://github.com/jiayuanliang0716-max/Arbitova) shows Claude Agent SDK, LangGraph, and CrewAI agents completing end-to-end escrows

---

## 8. Security Considerations

### 8.1 Reentrancy

Token transfers **MUST** happen after state transitions. The reference impl uses the checks-effects-interactions pattern.

### 8.2 Integer safety

`amount + fee` calculations **MUST NOT** overflow. Use fixed-width SafeMath or a compiler that inserts overflow checks (Solidity ≥0.8).

### 8.3 Arbiter compromise

A compromised arbiter can steal all escrowed funds in `DISPUTED` state. Mitigations:

- Multi-sig arbiter (2/3 or 3/5)
- Time-locked resolve (e.g., 24h window where resolve can be vetoed by either party, triggering escalation)
- Per-escrow arbiter selection (buyer picks at create time from a public list)

### 8.4 Verification URI mutability

The `verificationURI` is stored as a string on-chain but typically points off-chain. If the referenced document changes after escrow creation, dispute resolution becomes ambiguous. Implementations **SHOULD** encourage content-addressed URIs (IPFS, hash-pinned HTTPS).

### 8.5 Front-running

`confirmDelivery` and `resolve` payments are public. No known front-running attack, but miners/validators see mempool.

---

## 9. Open Questions

Marked for v0.2 discussion:

1. **Arbiter selection**: should the spec define a `chooseArbiter(...)` flow, or leave it fully out of scope?
2. **Partial delivery**: do we want native support for `markPartiallyDelivered` with a percent-complete field?
3. **Streaming / milestone escrows**: can the spec be extended for multi-tranche payments without breaking compat?
4. **Cross-chain escrows**: is the chain ID part of the spec, or do we leave cross-chain routing to a higher layer?
5. **Verdict precedents**: should verdicts reference prior verdicts (case-law style) to build a common-law-like arbiter precedent corpus?

File issues at [github.com/jiayuanliang0716-max/Arbitova/issues](https://github.com/jiayuanliang0716-max/Arbitova/issues) to propose amendments.

---

## 10. Versioning

This spec uses SemVer-like numbering:

- **Patch** (0.1.x): editorial clarifications, no interface change
- **Minor** (0.2.0): additive fields, backwards-compatible
- **Major** (1.0.0): breaking changes to method signatures or required events

A conforming implementation **MUST** declare which version it implements via a `version()` view function returning the string literal (e.g. `"a2a-escrow-v0.1"`).

---

## Appendix A — Example Flows

### A.1 Happy path (manual mode)

```
Buyer.approve(USDC, 5.00)
Buyer.createEscrow(seller, 5.00, 24h delivery, 12h review, "ipfs://Qm.../spec.json")
  → EscrowCreated(id=42, amount=5.00, ...)
Seller reads verificationURI, works, uploads artifact to IPFS
Seller.markDelivered(42, keccak256(artifact_cid))
  → Delivered(42, hash, reviewDeadline=now+12h)
Buyer fetches artifact, verifies against spec, satisfied
Buyer.confirmDelivery(42)
  → Released(42, toSeller=4.90, fee=0.10)
```

### A.2 Dispute path

```
... same as above up to Delivered
Buyer fetches artifact, not satisfied (wrong format)
Buyer.dispute(42, "Delivery was MP3, spec required WAV")
  → Disputed(42, by=buyer, reason="...")
Arbiter fetches spec, artifact, evidence
Arbiter publishes verdict.json to IPFS (90% buyer / 10% seller, 2% fee)
Arbiter.resolve(42, toBuyer=4.41, toSeller=0.49, verdictHash=keccak256(canonical(verdict.json)))
  → Resolved(42, toBuyer=4.41, toSeller=0.49, fee=0.10, verdictHash=0x...)
```

### A.3 Timeout / abandonment

```
Buyer creates escrow
24 hours pass, seller never calls markDelivered
Buyer.cancelIfNotDelivered(42)
  → Cancelled(42)  ; full refund to buyer
```

---

## Appendix B — Relationship to other standards

- **[Google A2A protocol](https://github.com/google/agent2agent)**: complementary. A2A Protocol covers agent-to-agent messaging. This spec covers the value transfer layer.
- **[MCP (Model Context Protocol)](https://github.com/modelcontextprotocol)**: complementary. An Arbitova-MCP server exposes escrow operations as MCP tools. See [smithery.ai/server/jiayuanliang0716/arbitova](https://smithery.ai/server/jiayuanliang0716/arbitova).
- **[EIP-2612 permit](https://eips.ethereum.org/EIPS/eip-2612)**: optional. Implementations MAY accept permit signatures to save buyers the `approve` transaction.
- **[ERC-7683 cross-chain intents](https://eips.ethereum.org/EIPS/eip-7683)**: potential future integration for cross-chain escrows.

---

## Appendix C — Change log

| Version | Date | Changes |
|---|---|---|
| 0.1.0 | 2026-04-22 | Initial draft |

---

*End of RFC v0.1 — feedback welcome.*
