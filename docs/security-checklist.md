# Security Checklist (v0.1)

Status: internal checklist. Lives in `docs/` so it can be audited and
referenced. Not a substitute for a real third-party audit of
`EscrowV1.sol`.

Scope: everything Arbitova currently ships that touches user funds,
keys, or operational trust boundaries. This document lists the
threats we have thought about and the mitigations we apply (or
explicitly do not apply, and why).

---

## 1. EscrowV1.sol — on-chain contract

### 1.1 Reentrancy

| Vector | Mitigation |
|---|---|
| Attacker contract as `seller`, re-enters on USDC transfer | `nonReentrant` on every external state-changing function; SafeERC20 for transfers |
| Attacker contract as `buyer`, re-enters on refund path | Same |
| Resolve path: fees and party payouts interleaved | Single `nonReentrant` scope; all transfers after state transition |

**Convention:** state changes precede external calls (Checks-Effects-Interactions).

### 1.2 Arithmetic

| Vector | Mitigation |
|---|---|
| Integer overflow in bps math | Solidity 0.8+ checked arithmetic; bps capped at 10_000; fee bps capped at 200/500 |
| Fee rounds down to zero on dust escrows | Accepted. Minimum escrow amount enforced client-side; on-chain fee=0 is not a safety issue |
| buyerBps + sellerBps != 10_000 | Explicit require in `resolve` |

### 1.3 Access control

| Function | Who can call |
|---|---|
| `createEscrow` | anyone |
| `markDelivered` | seller of that escrow |
| `confirmDelivery` | buyer of that escrow |
| `dispute` | buyer or seller |
| `cancelIfNotDelivered` | buyer, only when CREATED and past deliveryDeadline |
| `escalateIfExpired` | anyone, only when DELIVERED and past reviewDeadline |
| `resolve` | `arbiter` only |
| `setArbiter` / `setFee*` | `owner` only |

**Non-negotiable invariant:** there is NO path from DELIVERED to
RELEASED on timeout. Inaction always escalates to DISPUTED. The
arbiter cannot sweep funds — they can only split between the two
named parties.

### 1.4 Timestamp dependence

Block timestamp is used for `deliveryDeadline` and `reviewDeadline`
comparisons. Miner manipulation window is ~15 seconds on Base,
irrelevant at the review-window granularity (minutes to hours).

### 1.5 Audit gates before mainnet

- [ ] Full third-party audit of `EscrowV1.sol`
- [ ] Fuzz suite covering `createEscrow` → `resolve` state
  transitions (currently a unit test file; needs `forge test --fuzz`
  run with ≥1M runs)
- [ ] Formal check of "no DELIVERED → RELEASED on timeout" invariant
- [ ] Gas profiling with Base mainnet gas prices

---

## 2. Arbiter (off-chain component)

### 2.1 Current state

Single EOA signs `resolve(...)` calls after a Claude verdict passes a
0.7 confidence gate. Operated by Arbitova.

### 2.2 Threats

| Threat | Mitigation today | Planned |
|---|---|---|
| Arbiter key compromise | Hot key, hardware wallet storage | 3-of-5 Safe multisig (docs/multisig-arbiter-design.md) |
| Claude verdict hallucination | 0.7 confidence gate escalates to human review | Same |
| Correlated key+operator compromise | Kleros v2 path (docs/kleros-v2-integration-plan.md) |
| Operator coerced to sign biased verdict | Multisig raises cost; Kleros removes it entirely |

### 2.3 Rotation procedure

The current `arbiter` address is settable via `EscrowV1.setArbiter`.
This is `onlyOwner`. If the key is suspected compromised:

1. Owner (currently EOA; will be multisig) calls `setArbiter(newAddr)`
2. Users with active DISPUTED escrows are notified off-chain
3. Old arbiter address is revoked in internal rotation log

### 2.4 Arbitration review latency

Claude verdict runs in seconds. Confidence-gated escalations land in
the ops queue; target response time documented elsewhere. Liveness
of the arbiter is a known risk — disputed escrows can sit. No
automatic-release fallback by design.

### 2.5 Delivery content-hash verification SOP (M-4)

**Problem.** The arbiter feeds `delivery.content` (the seller's
submitted payload) to the LLM. If that content is tampered with
between delivery submission and arbitration — e.g., by a DB
compromise, a race during replication, a botched manual fix — the
verdict can be coherent, well-reasoned, and wrong, because it judges
a payload that is no longer what was actually delivered.

**Countermeasure.** At delivery time we record
`delivery_payload_hash = sha256(delivery.content)`. Before any verdict
is accepted the arbiter recomputes that hash and must see it match.

**Arbiter SOP (non-negotiable before `resolve` is signed):**

1. Build the evidence bundle via `buildEvidenceBundle(...)`.
2. Inspect `evidenceBundle.content_hash_match`:
   - `true`   → content is unchanged since delivery; verdict is safe
                to consider on its merits.
   - `false`  → **content diverges from its recorded hash.** Verdict
                is not safe. Arbiter MUST NOT sign `resolve`. Case is
                auto-escalated to human review (`escalate_to_human`
                is forced true with
                `escalation_reason = "delivery content_hash mismatch"`).
   - `null`   → no recorded hash for this delivery (legacy order or
                an integration that did not record one). Proceed, but
                log the advisory in `arbitration_verdicts.method`.
3. Hashes are recorded in the verdict as
   `delivery_payload_hash` (recorded) and
   `delivery_payload_hash_recomputed` (recomputed at verdict time),
   so the check is auditable after the fact.

**Where enforced in code:**

- `src/arbitrate.js :: verifyDeliveryContentHash(delivery)` — produces
  `{ match, recorded, recomputed }`.
- `src/arbitrate.js :: buildEvidenceBundle(...)` — surfaces
  `content_hash_match`.
- `src/arbitrate.js :: arbitrateDispute(...)` — forces
  `escalate_to_human = true` and sets `escalation_reason` when
  `content_hash_match === false`. This is a hard gate independent of
  LLM confidence or ensemble agreement.

**Where it ties back to the chain.** On-chain `resolve` is only
callable by the arbiter role; the arbiter signs off-chain after the
above SOP. A hash-mismatch verdict should never reach `resolve`; it
goes to human review, and from there either to human resolution or,
under Path B, to a Kleros escalation where jurors see the mismatch
evidence directly.

**Gap (acknowledged).** Today `delivery.content` is stored in
Postgres, and `payload_hash` is populated by the delivery endpoint
when that endpoint computes it client-side. Writing the hash to the
same row it fingerprints gives only tamper-evidence, not
tamper-prevention: an attacker who can rewrite `content` can rewrite
`payload_hash` too. Hardening options (any of them closes the gap):

- Anchor the hash on-chain at delivery time (cheap: one event).
- Store the hash in a separate append-only log signed by the seller.
- Require the seller to sign the content off-chain; verify the
  signature at arbitration time.

Tracked as a follow-up; current SOP detects drift caused by
operational mistakes, not by an attacker who owns the DB.

---

## 3. Key / secret hygiene

### 3.1 Server-side keys

| Key | Where stored | Access |
|---|---|---|
| `ARBITER_PRIVATE_KEY` | Render env var | Render dashboard admin |
| `ADMIN_KEY` | Render env var | — |
| `WALLET_ENCRYPTION_KEY` (legacy Path A) | Render env var | Retired with Path A; will be purged |

### 3.2 Rotation

- Any key present in a git history commit is considered burned.
  Rotate immediately and force-purge from secret stores.
- `ADMIN_KEY` is flagged for rotation; tracked in
  `project_arbitova_path_b.md` memory.

### 3.3 Client-side keys (users / agents)

Arbitova never sees, never stores, and never signs on behalf of any
user wallet. This is the central security property of the
non-custodial pivot. Any feature proposal that requires us to hold a
user key is automatically out of scope.

---

## 4. SDKs (`@arbitova/sdk` / `arbitova-python` / MCP server)

### 4.1 Input validation

- Addresses parsed via `ethers.getAddress` (checksums, length)
- Amounts parsed via `ethers.parseUnits(str, 6)` (throws on bad input)
- `verificationURI` treated as opaque string; **not** fetched by the
  SDK. Downstream agents that fetch it must validate scheme
  (prefer https://) and apply their own size limits.

### 4.2 Signer handling

- JS SDK: accepts an `ethers.Signer`; never serializes it
- Python SDK: accepts a hex-string private key or a LocalAccount; hex
  strings are not logged
- MCP server: read-only HTTP. Does not sign. Does not hold keys.
  Offers no mutation endpoints.

### 4.3 Supply chain

- `@arbitova/sdk` is the single source of truth for the ABI
- `@arbitova/x402-adapter` and future adapters peer-depend on it
- No dynamic require / eval in any SDK code path
- npm publish is manual; 2FA required on publisher account

---

## 5. Off-chain infra (Render)

| Surface | Secret exposure | Mitigation |
|---|---|---|
| `api.arbitova.com` Node server | Env vars only, no disk secrets | Render secret env vars |
| Daily reconcile cron | Reads chain state, writes Postgres | Read-only RPC; write-only to dedicated table |
| Arbiter signer service | Holds arbiter EOA key | Scoped to `resolve(...)` transactions only; refuses other call shapes |

---

## 6. Front-end (arbitova.com + app pages)

- Static HTML on Cloudflare Pages. No secret material.
- Wallet connection via wallet browser extensions; no mnemonic ever
  collected by Arbitova UI.
- CSP headers reviewed; no third-party script tags on `/pay/*` flow.
- Links to external explorers (Basescan) open in new tab with
  `rel="noopener noreferrer"`.

---

## 7. Known limitations (honest list)

- **Sepolia-only.** Not mainnet-deployed. Treat it as a testbed.
- **Single-EOA arbiter.** Multisig is designed but not deployed. This
  is the weakest link today.
- **No formal verification.** Relies on unit tests + manual review.
- **No bug bounty yet.** Planned post-mainnet with a realistic payout
  budget.
- **`ReputationV1` is unreviewed.** Draft contract; not deployed.
- **Kleros integration is plan-only.** No on-chain path exists today.

---

## 8. Pre-mainnet gates (aggregated)

Before any mainnet EscrowV1 deploy, every item below must be green:

- [ ] Third-party audit of EscrowV1.sol (no critical, no high)
- [ ] Fuzz suite (≥1M runs) clean
- [ ] Arbiter is a 3-of-5 Safe, not an EOA
- [ ] `ReputationV1` either deployed (post its own gates) or
  explicitly deferred
- [ ] Bug bounty announced with funded budget
- [ ] Incident response playbook (who gets paged when) written
- [ ] Public security contact (security@arbitova.com or PGP pubkey)

Do not move to mainnet just because testnet usage is high. Usage is
an argument for audit; audit is the gate.
