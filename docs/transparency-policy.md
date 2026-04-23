# Arbitova Transparency Policy (v1)

Status: **ADOPTED 2026-04-23**
Decision source: `docs/decisions/M-2-transparency-posture.md`
Architecture context: `docs/decisions/M-0-arbiter-architecture-v1.md`

---

## The commitment, in one sentence

**Every Arbitova arbitration verdict is public, per-case, queryable
by dispute ID, and includes the reasoning, the vote ensemble, any
escalation flags, and the result of any internal re-audit.**

No quarterly aggregation, no annual report as a substitute. The raw
data is available at `arbitova.com/verdicts` and mirrored by
on-chain events. If you want to know whether Arbitova ruled
correctly on a specific case, you can check the case directly. If
you want to compute our aggregate accuracy, you can do so from the
same data.

---

## Why this posture

Arbitova's brand claim is "everything can be verified." A
transparency policy that aggregates or delays ruling data would
be in tension with that claim. The founder explicitly chose to
accept the costs (early-stage sample noise, cherry-picking risk,
party privacy friction) as the price of living up to the claim.

This is written down here so that when the costs manifest —
and they will — the record shows they were anticipated and
accepted, not discovered.

---

## What is published, per case

For every dispute that reaches a verdict:

1. **Dispute metadata**
   - Dispute ID (uuid)
   - Order ID and escrow contract ID (on Base)
   - Buyer address, seller address (already public on-chain)
   - Escrow amount (USDC, already public on-chain)
   - Timestamps (dispute filed, verdict issued, multisig signed)

2. **Verdict**
   - Winner (buyer / seller / split)
   - Confidence score
   - Escalation flag (was this human-reviewed?)
   - Escalation reason (if escalated)

3. **Reasoning**
   - Full arbiter reasoning text
   - Vote ensemble breakdown (N=3 votes with each vote's winner,
     confidence, and model)
   - Any dissent summary
   - Constitutional-shortcut flag (if triggered)

4. **Evidence-bundle integrity**
   - `content_hash_match` (true / false / null if no recorded hash)
   - `delivery_payload_hash` (what was recorded)
   - `delivery_payload_hash_recomputed` (what the arbiter computed)

5. **Re-audit status**
   - Whether this case was selected for internal re-audit
   - If audited: re-audit verdict, re-audit reasoning, and
     agree/disagree flag vs original verdict
   - Re-audit timestamp and audit batch ID

6. **Link to on-chain proof**
   - Tx hash of the multisig `resolve` call
   - Contract-event ABI-decoded payload

---

## What is NOT published

- **Delivery payload content.** The SHA-256 hash of the payload
  is published; the payload bytes themselves are not. Seller IP,
  API keys embedded in delivery content, and any PII in the
  delivery remain private.
- **Off-chain chat / negotiation logs.** If parties communicated
  before filing a dispute, that history is not part of the
  published verdict bundle unless a party explicitly supplied it
  as evidence and consented to publication.
- **Agent operator identity beyond the wallet address.** We don't
  link wallet addresses to real-world identities. Parties can
  self-identify if they want to.

---

## The re-audit program

Even with maximum publication, we still need an internal quality
signal — the public can see every ruling, but only we can
systematically re-grade past rulings to detect drift.

**Sample rate:** 10% of rulings selected for re-audit.
**Selection method:** Random + confidence-weighted (lower-confidence
rulings sampled at higher rate, specifically rulings with final
confidence in the 0.60–0.75 band get 2× sample weight).
**Auditor:** A different operations person than the original ruler
(minimum). Target state, reached at 500 rulings: contracted
external arbitrator paid per case.

**Publication:** Re-audit results are published on the same
per-case page as the original verdict. If re-audit disagrees
with the original, both rulings are visible side-by-side. **We
do not quietly "correct" the original verdict.** The on-chain
verdict is what it is; re-audit is additional data, not
overwriting history.

**Pre-committed gate:**

> If the rolling-30-case re-audit disagreement rate exceeds **10%**,
> Arbitova publishes a public root-cause dev log within 30 days
> describing what the re-audits caught and what we're changing in
> the arbitration pipeline.

This gate is declared here so that it cannot be quietly removed
later without a visible edit to this document.

**Why 10%?** The 10% gate assumes internal re-audit is stricter
than external reversal (we're grading our own, with knowledge of
our own failure modes). In a world where Kleros-style external
reversal rates of 10–15% are "normal," an internal-only
disagreement rate should fall below external rates. 10% is the
tight bar; if we can't hit it, we owe an explanation.

---

## Party consent

Because per-case publication is a commitment that affects every
escrow, parties must be informed before they enter one.

**Contract-level disclosure:** The arbitova.com SDK documentation
and the in-app UI (before escrow creation) must state, in plain
language:

> If this escrow is disputed and resolved by Arbitova
> arbitration, the verdict, reasoning, vote breakdown, and any
> internal re-audit result will be published at
> arbitova.com/verdicts. The delivery payload itself is not
> published (only its hash). Your wallet address is already
> public on-chain.

**Implementation:**
- SDK `createEscrow()` call documentation: add a "publicity"
  section that links here.
- arbitova.com escrow-creation UI: consent banner that must be
  acknowledged (not a blocker — agents are expected to consume
  this programmatically via SDK, not through a click UI; but
  for human-facing flows it's a required acknowledgment).
- This is not a cryptographic consent (we can't enforce it
  on-chain), it's a documented-terms-of-service signal.

---

## The dashboard

Location: `https://arbitova.com/verdicts`

**List view:** Paginated list of all verdicts, most recent first.
Columns: dispute ID (truncated), date, escrow size, winner,
confidence, escalated flag, re-audited flag.

**Filter surface:** Date range, winner, escrow-size bucket,
escalated-only, re-audited-only, disagreement-only.

**Per-case view:** `/verdicts/{disputeId}` — full data per the
"What is published" section above, plus a link to the on-chain
tx on Basescan.

**Machine surface:** `/verdicts.json` (latest N) and
`/verdicts/{disputeId}.json` (structured). This is for
programmatic consumers (researchers, critics, third-party
aggregators). **We explicitly want people to build independent
dashboards from our data; this endpoint exists to make that
easy.**

**No crawler robots.txt restriction.** Search engines and
archive services may index this tree. That's intentional.

---

## Known risks we are accepting

1. **Cherry-picking.** A critic posts a single bad ruling on
   Twitter without context. We cannot prevent this. Our
   defense is that every case is visible in context, and we
   commit to a public response (in a blog comment or dev log)
   when a specific case becomes a public talking point.

2. **Early-stage sample noise.** Cases 1–10 will be the most
   reverence-attracting because they're the only data. Some
   percentage of the first 10 will produce a bad headline. We
   accept this and will not game case acceptance to make the
   early sample look better.

3. **Party discomfort.** Some buyers or sellers will not want
   their dispute on a public page. Our mitigation is
   pre-disclosure at escrow creation — by using Arbitova, the
   parties accept this posture. If this generates churn, it's
   churn of users who are not aligned with the product's core
   claim.

4. **Competitor intelligence.** Competitors can see every
   ruling we make and every mistake we ship. We accept this.
   The alternative (hiding) is worse for the brand.

5. **Legal / GDPR exposure.** Publishing per-case data with
   wallet addresses (which are not PII under most jurisdictions
   but are not zero-PII either) may interact with specific
   jurisdictions' data-protection rules. **This is a Phase 5
   legal-primer item.** Counsel will tell us what, if any,
   specific adjustments this policy needs.

---

## How this interacts with the single-tier arbiter architecture (M-0)

M-0 removed the external appeal layer (Kleros) for v1. In a
two-tier world, external reversal rate was the canonical trust
signal. In v1, we replaced that signal with:

1. Per-case publication (this policy).
2. Internal re-audit with published results and a 10% gate.
3. Contract-level escape hatch (`Pausable`) for
   catastrophic-error scenarios.

Together these three mechanisms are the answer to "but who
checks you?" **No external arbiter checks us. The public
checks us. The re-audit program checks us. The pause switch
exists if we break badly enough to need it.**

---

## When this policy changes

Any change to this policy must:
1. Be proposed in a dev log.
2. Include the rationale and the new commitment.
3. Include explicit comparison to the old commitment so readers
   can see what we're giving up.
4. Be approved by the founder.

The pre-committed 10% gate, in particular, cannot be relaxed
without a public dev log explaining why. We cannot quietly
change the number. That's the commitment behind the commitment.
