# Two-Tier Arbitration Design (v0.1 draft)

Status: design draft. No contract changes, no Kleros deployment.
Author: Arbitova / 2026-04-23.
Supersedes: `docs/multisig-arbiter-design.md` (single-tier) and
`docs/kleros-v2-integration-plan.md` (pure Kleros) as the **target
mainnet architecture**. Those two docs remain valid as descriptions
of the individual layers.

---

## TL;DR

Mainnet `EscrowV1` will route disputes through two tiers:

1. **First instance — Arbitova.** The existing Claude-based arbitration
   pipeline issues a ruling within hours. A 3-of-5 Safe multisig
   signs the on-chain `resolve` transaction. Identical to today's
   Sepolia flow.
2. **Appeal — Kleros v2.** Either party may appeal within a fixed
   window by posting a bond. The case is re-tried by a Kleros
   jury; the Kleros ruling overrides the first-instance ruling.

Expected traffic split (based on real-world appeal rates in analogous
systems): ~95% of disputes settle at tier 1, ~5% escalate to tier 2.
Tier 1 is fast and cheap; tier 2 is slow and expensive but only
invoked when at least one party is willing to pay for independent
review.

This is the design that was chosen in the 2026-04-23 strategy
discussion. It was proposed by the founder, not by any external
consultant, and supersedes the earlier binary choice between
"multisig only" and "Kleros only."

---

## Why this, not the alternatives

| Criterion                           | Multisig only | Kleros only | **Two-tier** |
|-------------------------------------|:-------------:|:-----------:|:------------:|
| Fast resolution (<24h)              | ✅            | ❌          | ✅ (95%)     |
| Cheap for small-ticket escrows      | ✅            | ❌          | ✅ (95%)     |
| Viable for large-ticket escrows     | Disputed     | ✅          | ✅           |
| Independent of Arbitova's integrity | ❌            | ✅          | ✅ (appeal)  |
| Arbitova keeps product identity     | ✅            | ❌          | ✅           |
| Self-improving feedback loop        | No signal     | No signal   | ✅ (reversal rate) |
| Regulatory posture                  | "We judge"   | "We route" | **"We judge, users can appeal"** |

The right mental model is the real-world judicial system: district
court → appellate court. Real data on appeal systems: US federal
civil cases are appealed ~11% of the time; PayPal disputes
escalate to credit-card chargeback ~3% of the time. Appeal
mechanisms do *not* replace first instance; they constrain it.

---

## User experience

### Buyer view (disputes a delivery)

```
  Day 0   Buyer files dispute (signs reason + evidence).
  Day 0   Arbitova AI analyzes, produces verdict + confidence.
          If confidence < 0.7, routes to human multisig review.
  Day 1   Multisig executes resolve() → escrow enters
          PROVISIONAL_RESOLVED. Funds are split per ruling
          but NOT yet paid out.
  Day 1   Both parties are notified: "ruling X, you have 7 days
          to appeal. Appeal fee: $Y."
  Day 8   If no appeal: finalize() callable by anyone →
          RESOLVED. Funds pay out.
  (or)
  Day 2–7 Seller appeals. Posts bond. Case enters UNDER_APPEAL.
          Kleros jury assembles (3 or 15 jurors based on case
          size). Jury votes within Kleros's own timeline
          (typically 3–7 days).
  Day 12  Kleros rules. rule() callback → RESOLVED with Kleros
          ruling (possibly different from first-instance ruling).
          Funds pay out. Appeal bond returned if appeal succeeded,
          forfeit if appeal failed.
```

### Seller view (shipping to a disputing buyer)

Symmetric. Seller sees the same state progression. Either party
may appeal — the side that lost at first instance has obvious
motive; the side that won may want to lock in the ruling by not
appealing (and therefore saving the appeal window from being
gamed).

### Happy-path (no dispute) is unchanged

`CREATED → DELIVERED → RELEASED`. Two-tier only exists for the
dispute branch.

---

## State machine

### Current (single-tier)

```
CREATED ──delivered──> DELIVERED ──confirmed──> RELEASED
   │                       │
   │                       └──disputed──> DISPUTED ──resolve──> RESOLVED
   │
   └──cancelled──> CANCELLED
```

### Proposed (two-tier)

```
CREATED ──delivered──> DELIVERED ──confirmed──> RELEASED
   │                       │
   │                       └──disputed──> DISPUTED
   │                                          │
   │                                   resolveFirstInstance
   │                                          ▼
   │                              PROVISIONAL_RESOLVED
   │                                  │           │
   │                          appeal()         finalize()
   │                                  ▼           ▼  (after 7 days)
   │                            UNDER_APPEAL    RESOLVED
   │                                  │
   │                         Kleros rule()
   │                                  ▼
   │                             RESOLVED
   └──cancelled──> CANCELLED
```

### Enum changes

```solidity
// Before
enum State { CREATED, DELIVERED, RELEASED, DISPUTED, RESOLVED, CANCELLED }

// After (backwards-compatible: new values appended at the end)
enum State {
    CREATED,                // 0
    DELIVERED,              // 1
    RELEASED,               // 2
    DISPUTED,               // 3
    RESOLVED,               // 4
    CANCELLED,              // 5
    PROVISIONAL_RESOLVED,   // 6 (new) — first-instance ruling issued, appeal window open
    UNDER_APPEAL            // 7 (new) — Kleros dispute pending
}
```

Appending new states at the end preserves the numeric encoding of
existing states. Off-chain indexers that only recognize the old
states will see escrows get "stuck" in PROVISIONAL_RESOLVED or
UNDER_APPEAL until they resolve, but will not misinterpret old
records.

---

## Contract surface changes

Three new functions; one existing function renamed.

### `resolveFirstInstance(id, buyerBps, sellerBps, verdictHash)`

Renamed from today's `resolve`. `onlyArbiter`. Transitions
`DISPUTED → PROVISIONAL_RESOLVED`. Stores the provisional split
and starts the appeal window clock.

**Does not pay out.** Funds remain in the contract.

### `appeal(id)`

Callable by either party (buyer or seller) during the appeal
window. Requires `msg.value == appealBond(id)` (or an ERC-20
variant if bond is USDC-denominated).

Transitions `PROVISIONAL_RESOLVED → UNDER_APPEAL`. Calls
`IArbitratorV2(kleros).createDispute{value: klerosArbitrationCost}(...)`.
Records the Kleros `disputeId` and the appellant's address.

### `finalize(id)`

Callable by anyone after the appeal window has elapsed, provided
no appeal was filed. Transitions `PROVISIONAL_RESOLVED → RESOLVED`
using the provisional split. Pays out.

Separating finalization from first-instance ruling is what makes
the appeal window observable and non-racy. If `resolveFirstInstance`
paid out immediately, the appeal mechanism would be meaningless.

### `rule(disputeId, ruling)` (existing in Kleros draft)

Called back by the Kleros arbitrator. `onlyKleros` (i.e. only
callable by the configured arbitrator address).

Maps the ruling to a `(buyerBps, sellerBps)` pair (see Kleros draft
for the 1/2/0 → split mapping).

Transitions `UNDER_APPEAL → RESOLVED`. Pays out per Kleros ruling.
If the Kleros ruling *differs* from the provisional ruling, the
appeal bond is returned to the appellant; otherwise forfeited.

---

## Three design decisions that need founder sign-off

### D-1: Appeal bond size

The bond must be large enough to deter frivolous appeals and cover
Kleros's own arbitration fee, but small enough that a legitimate
appellant can realistically post it.

**Options:**

| Option               | Bond formula                             | Effect                                              |
|----------------------|------------------------------------------|-----------------------------------------------------|
| (a) Flat             | Fixed $50                                | Simple. Broken for $1 escrows and $100k escrows.    |
| (b) % of escrow      | max($20, escrow_amount × 10%)            | Scales. Small escrows protected, large ones costly. |
| **(c) Floor + % cap**| **max(kleros_fee × 1.2, amount × 10%)**  | **Scales, always covers Kleros, hard cap**          |

**Recommendation: (c).** The floor guarantees the Kleros fee is
always covered by the bond (so we don't subsidize appeals out of
our own treasury). The percentage cap prevents the bond from being
trivial on large escrows.

**Bond refund logic:**
- If Kleros ruling == provisional ruling → appellant forfeits bond.
  The bond pays Kleros's fee; any excess is distributed per the
  fee split (protocol revenue or burned; see D-3).
- If Kleros ruling ≠ provisional ruling → appellant is refunded
  the full bond; Kleros fee is paid from the escrow's protocol fee
  budget. (Rationale: the first instance was wrong, the appellant
  shouldn't pay to correct our error.)

### D-2: Appeal window length

**Options:** 24 hours, 3 days, **7 days**, 14 days.

**Recommendation: 7 days.**

- Short enough that funds aren't locked indefinitely.
- Long enough for an agent's human overseer to wake up, read the
  ruling, consult someone, and post a bond.
- Matches the format of `delivery_window` and `review_window`
  already used in the contract.
- Credit-card chargeback windows run 60–120 days; blockchain
  settlement norms are tighter. 7 days is the reasonable midpoint.

**Edge case:** what if the review_window and appeal_window overlap
in a way that creates adversarial timing? Review window ends before
delivery is disputed, so there's no actual overlap. Documented here
for auditor context.

### D-3: Reversal-rate transparency

Over time, the ratio "(Kleros ruling ≠ provisional ruling) / (total
appealed cases)" is a public-facing signal of how accurate the
first-instance pipeline is.

**Options:**

| Option       | Exposure            | Brand implication                      |
|--------------|---------------------|----------------------------------------|
| (a) Private  | Internal dashboard  | Safer commercially, weaker brand.      |
| (b) Aggregated quarterly | Public stat | Middle ground. Some noise OK.          |
| **(c) Fully public, per-case** | **Query any dispute and see both rulings** | **Maximally verifiable** |

**Recommendation: (c).**

Rationale: Arbitova's entire brand claim is "everything can be
verified." Hiding our own accuracy metric contradicts that claim.
The indexer already emits `FirstInstanceResolved` and `AppealRuling`
events; exposing them in a dashboard is additive, not a new data
flow.

**Operational commitment:** if quarterly reversal rate exceeds 15%,
we publish a root-cause dev log within 30 days and describe what
we're changing in the arbitration pipeline. This is a pre-committed
accountability gate, not a marketing promise.

---

## Economics

### Who pays what

| Actor              | First instance                   | Appeal                                                   |
|--------------------|----------------------------------|----------------------------------------------------------|
| Buyer              | 2% platform fee (existing)       | Potentially posts bond if appellant                      |
| Seller             | 2% platform fee (existing)       | Potentially posts bond if appellant                      |
| Arbitova           | Runs AI pipeline + multisig      | Pays Kleros fee if first instance was wrong              |
| Kleros jurors      | —                                | Paid from appellant's bond (on reversal: from our fees)  |

### Protocol fee impact

No change to the existing 2% platform fee on RELEASE and RESOLVE.
Appeals do not charge an incremental protocol fee. The appeal bond
is a deterrent/escrow for the Kleros cost, not Arbitova revenue.

### Worst-case for Arbitova treasury

Every appealed case where we're wrong costs us the Kleros fee
(~$20–$50). If 5% of disputes go to appeal and we're reversed 30%
of the time, the expected cost per dispute is ~$0.30–$0.75.
Against a ~$2–$20 platform-fee revenue per dispute, this is
sustainable. We should model this with real numbers once Sepolia
shows traffic.

---

## Migration plan

### Phase 0 — docs (this PR)

Publish this doc. Update roadmap. Dev Log on the decision.

### Phase 1 — Sepolia dual-mode

- Surgical amend of `EscrowV1.sol`: add PROVISIONAL_RESOLVED and
  UNDER_APPEAL states, split `resolve` into `resolveFirstInstance`
  and `finalize`, add `appeal`.
- Leave `arbiter` as a single EOA on Sepolia for testing speed.
- Deploy alongside a Kleros v2 mock or their Sepolia instance.
- Run three synthetic scenarios end-to-end (see Phase 2 in
  `multisig-arbiter-design.md`), plus three new scenarios:
  - Dispute → first-instance ruling → no appeal → finalize clean.
  - Dispute → first-instance ruling → buyer appeals → Kleros
    upholds → bond forfeit.
  - Dispute → first-instance ruling → seller appeals → Kleros
    reverses → bond refunded + opposite payout.

### Phase 2 — Sepolia with multisig + Kleros

- Move arbiter to the 3-of-5 Safe described in
  `multisig-arbiter-design.md`.
- Wire `rule()` callback to Kleros Sepolia.
- Run the same six scenarios with real multisig signatures and
  real Kleros Sepolia jurors.
- Operate for 4 weeks. Measure: multisig SOP feasibility, Kleros
  jury UX from the disputant side, reversal rate on synthetic cases.

### Phase 3 — Mainnet (gated)

All four existing gates from `architecture.html` still apply
(audit, multisig, arbiter registry, one-week indexer run), plus
two new gates:

- Kleros v2 mainnet integration tested with at least 10 real cases.
- Appeal bond and appeal window parameters locked via governance
  (or, in v0.1, hard-coded in the contract with an upgrade path
  clearly documented).

---

## What this does NOT change

- Non-custodial property. The contract still holds all funds; no
  off-chain balance table; no admin withdraw.
- Content-hash integrity. `markDelivered(id, hash, uri)` unchanged.
- The 2% platform fee. Unchanged.
- The state enum encoding for existing states (0–5). Unchanged.
- The SDK surface for the 95% happy-path flow (`createEscrow`,
  `markDelivered`, `confirmDelivery`, `cancel`). Callers that never
  touch the dispute branch see identical behavior.

---

## What this DOES change — SDK 4.x major version bump (breaking)

Earlier drafts of this doc claimed "no breaking change." That was
wrong. The contract surface changes below break binary compatibility
and require a coordinated SDK major-version release. This section
enumerates every breaking change and the migration path for each.

### Contract ABI breakages

| Change                                       | What breaks                                                        |
|----------------------------------------------|--------------------------------------------------------------------|
| `resolve(...)` → split into two functions    | Any caller/indexer decoding `resolve` by selector or name          |
| `resolveFirstInstance(id, bps..., hash)`     | New selector; ABI diff                                             |
| `finalize(id)`                               | New selector; must be called after appeal window                   |
| `appeal(id)` payable                         | New selector; requires bond value                                  |
| `rule(disputeId, ruling)` Kleros callback    | New selector; only callable by `IArbitratorV2`                     |
| State enum grows from 6 → 8 values           | Off-chain decoders must enumerate 6 and 7, not just 0–5            |
| New events `FirstInstanceResolved`, `Appealed`, `AppealRuling` | Indexers must add these or miss the dispute branch |

### SDK-side breakages (`@arbitova/sdk` 3.x → 4.x)

| Caller                                | Before (3.x)               | After (4.x)                                                      |
|---------------------------------------|----------------------------|------------------------------------------------------------------|
| Arbiter service (multisig signer tool)| `sdk.resolve(id, buyerBps, sellerBps)` | `sdk.resolveFirstInstance(id, buyerBps, sellerBps, verdictHash)` |
| Anyone                                | *n/a*                      | `sdk.finalize(id)` (callable after appeal window if no appeal)   |
| Disputing party                       | *n/a*                      | `sdk.appeal(id, bondAmount)`                                     |
| Indexer / block-reader                | `State ∈ {0..5}`           | `State ∈ {0..7}`; handle 6/7 or ignore with explicit fallthrough  |
| Typing (`EscrowState` union)          | 6 members                  | 8 members; TypeScript users must exhaust `PROVISIONAL_RESOLVED` and `UNDER_APPEAL` |
| `getEscrow(id).state` return          | same encoding              | callers that do `if state === RESOLVED` must *not* assume dispute path ended; inspect `PROVISIONAL_RESOLVED`/`UNDER_APPEAL` too |

### Python SDK (`arbitova` 2.x → 3.x)

Same breakages, Python-typed. The existing `resolve()` wrapper must
be removed (or kept only as a deprecation shim that raises on call).
`ArbitrationState` enum gains two members. Tests that assert
`state in {CREATED, DELIVERED, RELEASED, DISPUTED, RESOLVED, CANCELLED}`
will fail until updated.

### MCP server (`@arbitova/mcp-server` 4.x → 5.x)

Tool schemas change. `resolve_dispute` tool removed; replaced by
`resolve_first_instance`, `finalize_escrow`, `appeal_escrow` tools.
Agents that discovered tools via the old MCP server will not see
the new ones until the client refetches the schema.

### Migration guide for integrators

1. **Happy-path callers** (buyers calling `createEscrow`/`confirm`,
   sellers calling `markDelivered`): no change required. Upgrade
   SDK at your convenience.
2. **Arbiter-side callers** (anyone with the arbiter key): MUST
   upgrade to SDK 4.x before the contract migration is deployed,
   and MUST stop calling `resolve` (it no longer exists as an
   entrypoint).
3. **Indexers / subgraphs**: MUST update state-enum decoders and
   add handlers for the three new events before mainnet cut-over.
4. **Agent operators using MCP**: force a tool-schema refetch after
   `@arbitova/mcp-server` 5.0.0 releases. Agents whose tool list is
   cached will silently miss the new flows.

### Version strategy

- SDKs ship `4.0.0-beta` / `3.0.0-beta` as the first release against
  a Sepolia deployment of the amended contract. Beta stays ≥4 weeks.
- `resolve` is not removed from the old (3.x SDK) package; the old
  package remains installable for anyone pinned to the non-two-tier
  EscrowV1. Mainnet cutover retires the 3.x line to maintenance only.
- A `CHANGELOG_V4.md` ships in each SDK with every breakage listed
  and a codemod script for the common rename (`resolve` →
  `resolveFirstInstance`).

---

## Open questions (for resolution during Phase 1)

1. **Should the buyer be able to appeal a ruling in their own
   favor?** Example: ruling is 60/40 buyer, buyer wanted 100/0.
   Narrow answer: yes, but bond economics rarely make it
   rational. Worth documenting in SOP.
2. **What if both parties appeal simultaneously?** First appeal
   transitions the state; second appeal reverts. First-come-first-
   served is a simple rule but may feel unfair. Consider: allow
   *either* party to appeal, regardless of whether they "lost,"
   and Kleros gets one unified re-trial.
3. **Timelock on parameter changes.** `setAppealBond` and
   `setAppealWindow` should be owner-gated with a timelock so
   a parameter change doesn't catch in-flight disputes with new
   rules mid-appeal.
4. **Bond currency.** ETH (simpler, matches Kleros native fee) vs.
   USDC (consistent with escrow asset). Recommendation: start with
   ETH for Phase 1, evaluate USDC for mainnet.
5. **Appeal escalation beyond Kleros.** Kleros itself has a
   multi-round appeal structure internally. We treat "Kleros
   ruling final" as final. Document this as a deliberate
   simplification, not an oversight.

---

## Related documents

- `docs/multisig-arbiter-design.md` — tier-1 multisig details (still valid).
- `docs/kleros-v2-integration-plan.md` — tier-2 Kleros wiring (still valid).
- `contracts/draft/EscrowV1WithKleros.sol` — starting point for the
  surgical amend in Phase 1.
- `docs/architecture.html` — public-facing summary; will be updated
  after this design is approved.
- Dev Log entry for the two-tier decision — to be drafted after
  this doc lands.

---

## Decision record

- 2026-04-23: Two-tier architecture chosen over pure multisig and
  pure Kleros. Framing: "AI-first arbitration with decentralized
  appeal." Founder-originated design; not consultant-imposed.
