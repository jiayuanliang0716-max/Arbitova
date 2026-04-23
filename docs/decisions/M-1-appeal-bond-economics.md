# M-1 Decision Brief: Appeal Bond Economics for Small Escrows

> ⚠️ **SUPERSEDED 2026-04-23.** Founder decided v1 ships without
> Kleros appeal. See `docs/decisions/M-0-arbiter-architecture-v1.md`.
> No bond means no bond-economics problem. This brief is retained
> for historical context and as reference material if appeal is
> added in Phase 6 via UMA or equivalent.

Status: ~~AWAITING FOUNDER DECISION~~ **SUPERSEDED by M-0**
Source audit finding: `docs/remediation-plan.md` row M-1
Date: 2026-04-23

---

## The problem in one paragraph

Kleros v2's own arbitration fee on Base is ~$60 per case (drawn from
recent `arbitrable.eth` cases in Kleros Court). Our recommended bond
formula is `max(kleros_fee × 1.2, escrow × 10%)`. For a $5 escrow, the
bond is therefore ~$72 (the floor dominates). **A rational agent will
never appeal a $5 dispute**: even if the first-instance ruling is
wrong, paying $72 to recover $5 is irrational. This means for the
entire class of small-ticket A2A transactions (the majority of our
target market at launch), the "appeal" path is cosmetic. If an
Arbitova first-instance ruling is wrong on a $5 escrow, the losing
party eats it.

The two-tier pitch is "fast AI judgment with decentralized appeal."
If appeal is economically unreachable for most of our volume, that
pitch is half-true. We need an explicit policy decision now so the
brand claim, the contract, and the SDK docs all match reality.

---

## Three options

### (a) Threshold — single-tier below $X, two-tier above

Below $X (recommended: **$100**), the escrow contract is
single-instance: Arbitova multisig rules, no appeal path exists.
Above $X, the full two-tier path is active.

**Pros:**
- Honest: no fake appeal button that no one will press.
- Simple contract: one branch on `amount`.
- Matches reality — we're not pretending to offer something
  we can't deliver.

**Cons:**
- Brand contradiction: "every dispute can be appealed" becomes
  "every dispute over $100 can be appealed." Marketing pivot needed.
- Splits the product surface: two classes of escrow with different
  guarantees. SDK users must be told.
- If an attacker learns that $99 escrows have no appeal, they can
  size disputes deliberately under the threshold. This is a
  **targeted first-instance capture** attack surface.

**Cost:** zero treasury cost. Engineering: ~1 day (contract branch
+ SDK docs + UI copy).

---

### (b) Subsidy — Arbitova treasury covers small-escrow bonds

Arbitova maintains a treasury-funded pool that, on appeal of a
sub-$X escrow, **posts the Kleros bond on behalf of the appellant**.
Cap: $N/month (recommended: start with **$500/month** to survive
a worst-case 8 small-escrow appeals; adjust quarterly based on actual
traffic).

If Kleros reverses the first-instance ruling, the appellant is made
whole from the reversal-recovered bond plus the usual fee refund
logic. If Kleros upholds, the subsidy is spent (treated as an
operational cost, not a loss to the appellant).

**Pros:**
- Brand-consistent: appeal is *actually* available to everyone.
- Reversal-rate signal remains clean — we still see where we're
  wrong on small cases.
- Cost is bounded by the monthly cap, so finance can budget.
- Goodwill moat: competitors who can't afford this subsidy can't
  match the promise.

**Cons:**
- Someone (us) pays for Kleros fees on cases where the first
  instance was correct — a direct subsidy of our own errors being
  checked.
- Introduces a "subsidy exhausted" failure mode: if the monthly
  cap is hit, appeals below threshold revert to unavailable.
  Needs clear UX around "subsidy pool remaining."
- Creates a weak abuse surface: a malicious party could DoS the
  subsidy pool by filing frivolous small-escrow appeals to
  exhaust the monthly budget, denying appeals to legitimate users
  later in the month. Mitigate with per-agent rate limits.

**Cost:** up to $N/month treasury burn. Engineering: ~3 days
(treasury manager contract + cap bookkeeping + rate limit + UI).

---

### (c) Batch — aggregate N small cases into one Kleros case

The appeal contract accepts "batch appeals": up to N (recommended:
**5**) small-escrow disputes over the same appeal window can be
bundled into a single Kleros case. The jurors are asked to rule on
each case independently within the same proceeding. Fee is shared
across the batch (so per-case cost drops to ~$12 for a 5-case
batch).

**Pros:**
- Economically cleanest: per-case cost drops linearly with batch
  size, with no treasury cost.
- No brand contradiction — appeal is available for every case.
- Scales with volume: more traffic → more batching opportunities
  → cheaper per-case appeals.

**Cons:**
- Kleros jurors must read N unrelated cases in one proceeding.
  This is uncommon in Kleros court culture; may confuse jurors
  and degrade ruling quality.
- Latency: an appellant must wait for the batch to fill or for a
  max-wait timer to expire. A single small-escrow dispute may
  wait up to 72h before its Kleros case is filed.
- Engineering complexity: batch construction, partial-batch
  dispatch after timeout, per-case result extraction from a
  single Kleros ruling. Non-trivial.
- If one case in a batch is reversed and the other 4 are upheld,
  fee attribution and bond refunds become arithmetic-heavy. Bug
  surface.

**Cost:** near-zero treasury cost. Engineering: ~2 weeks
(batch contract + Kleros evidence formatting + timer scheduler
+ per-case result parser). Plus outreach to the Kleros community
to explain how to juror-rule on batched A2A cases.

---

## Recommendation

**(a) Threshold at $100, publicly documented.**

Reasoning:
1. It's the only option that ships in <1 week.
2. Arbitova is at **zero paying customers today** (2026-04-23). We
   do not have traffic data to size option (b)'s subsidy cap
   correctly. Shipping (b) with a wrong cap is worse than shipping
   (a).
3. Option (c) has real merit but the juror-education cost is not
   something we can underwrite pre-product-market-fit. Revisit at
   Phase 6 (post-audit, actual traffic).
4. Option (a) is **reversible** — we can ship (a) now, collect 3
   months of real appeal-attempt data, then upgrade to (b) or (c)
   once we know the actual small-escrow appeal rate.

**If the founder chooses (a):** we update the marketing copy on
arbitova.com and the Two-Tier Arbitration doc to explicitly say
"escrows below $100 are single-instance (Arbitova final)." Nothing
hidden.

**If the founder chooses (b):** I can draft the treasury manager
contract. But I flag that we need to defer Phase 4 Sepolia deploy
by ~3 days for the extra contract surface, and we need a
cap-exhausted UX flow.

**If the founder chooses (c):** defer to Phase 5 or later. Not
compatible with Phase 4 timeline.

---

## Decision record

- [ ] Founder choice: ______  (a / b / c)
- [ ] Date: ______
- [ ] Rationale if different from recommendation: ______
- [ ] Follow-up: update `two-tier-arbitration-design.md` D-1 section
  to state the chosen path (remove "three options" language)
- [ ] Follow-up: update marketing copy on arbitova.com to match
- [ ] Follow-up: if (a), add `MIN_APPEAL_THRESHOLD_USDC = 100e6` as
  a public `immutable` in `EscrowV1Appeal.sol`
