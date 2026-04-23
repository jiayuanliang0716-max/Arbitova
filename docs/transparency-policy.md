# Arbitova Transparency Policy (v1.1)

Status: **ADOPTED 2026-04-23 · AMENDED 2026-04-24** (re-audit program removed — see §"When this policy changes")
Decision source: `docs/decisions/M-2-transparency-posture.md`
Architecture context: `docs/decisions/M-0-arbiter-architecture-v1.md`
Amendment rationale: dev log #023

---

## The commitment, in one sentence

**Every Arbitova arbitration verdict is public, per-case, queryable
by dispute ID, and includes the reasoning, the vote ensemble, and
any escalation flags.**

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

5. **Link to on-chain proof**
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

## Party consent

Because per-case publication is a commitment that affects every
escrow, parties must be informed before they enter one.

**Contract-level disclosure:** The arbitova.com SDK documentation
and the in-app UI (before escrow creation) must state, in plain
language:

> If this escrow is disputed and resolved by Arbitova
> arbitration, the verdict, reasoning, and vote breakdown will
> be published at arbitova.com/verdicts. The delivery payload
> itself is not published (only its hash). Your wallet address
> is already public on-chain.

**Implementation:**
- SDK `createEscrow()` call documentation: includes this disclosure
  in the JSDoc and in `README.md`.
- arbitova.com escrow-creation UI (`/pay/new`): disclosure hint
  visible above the "Lock funds in escrow" button.
- This is not a cryptographic consent (we can't enforce it
  on-chain), it's a documented-terms-of-service signal.

---

## The dashboard

Location: `https://arbitova.com/verdicts`

**List view:** Paginated list of all verdicts, most recent first.
Columns: dispute ID (truncated), date, escrow size, winner,
confidence, escalated flag.

**Filter surface:** Date range, winner, escrow-size bucket,
escalated-only.

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

6. **No internal quality signal beyond the public record.**
   As of the 2026-04-24 amendment, Arbitova does not commit
   to an internal re-audit program (see below). The public
   record is the only quality signal this policy promises.
   Readers who want a secondary check must construct it from
   the published data themselves.

---

## How this interacts with the single-tier arbiter architecture (M-0)

M-0 removed the external appeal layer (Kleros) for v1. In a
two-tier world, external reversal rate was the canonical trust
signal. In v1, we replaced that signal with:

1. Per-case publication (this policy).
2. Contract-level escape hatch (`Pausable`) for
   catastrophic-error scenarios.

Together these two mechanisms are the answer to "but who
checks you?" **No external arbiter checks us. The public
checks us. The pause switch exists if we break badly enough
to need it.**

---

## When this policy changes

Any change to this policy must:
1. Be proposed in a dev log.
2. Include the rationale and the new commitment.
3. Include explicit comparison to the old commitment so readers
   can see what we're giving up.
4. Be approved by the founder.

### Amendment log

**2026-04-24 — re-audit program removed.**
Rationale: dev log #023. The original v1 policy (2026-04-23)
committed Arbitova to a 10% sample re-audit of every verdict,
executed by a second operator, with a pre-committed rolling-30
disagreement gate at 10% that would force a public root-cause
dev log within 30 days on breach. The amendment removes this
commitment in full. What changed between 2026-04-23 and
2026-04-24: the re-audit SOP was drafted (see `docs/arbiter-ops-runbook.md`
git history) and we confirmed it required a second operator
Arbitova does not currently staff. Rather than keep a commitment
we could not execute, we scoped the promise down to what the
current team can deliver — per-case public publication — and
removed the re-audit mechanism. If a quality-signal program
returns in a future version, it will be proposed via dev log
with operational staffing attached to the proposal, not left
aspirational.

What we gave up: the internal disagreement gate, the public
post-mortem clock, and the re-audit bundle in every per-case
page. What we kept: per-case publication, every dispute visible,
no aggregation substitute, the same disclosure and consent
surface at the SDK and UI.
