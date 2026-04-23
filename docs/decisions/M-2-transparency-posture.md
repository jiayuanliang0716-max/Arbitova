# M-2 Decision Brief: Transparency Posture (single-tier revision)

Status: **AWAITING FOUNDER DECISION**
Source audit finding: `docs/remediation-plan.md` row M-2
Reframed: 2026-04-23 after M-0 (no Kleros in v1)
Date: 2026-04-23

---

## What changed since the original M-2 brief

The original M-2 brief assumed a two-tier arbitration system
where Kleros was the external reviewer. In that world, the public
quality signal was **reversal rate** — how often Kleros disagreed
with Arbitova.

After M-0, there is no Kleros. There is no independent reviewer.
There is no reversal rate to publish. The transparency question
reshapes into:

> **How do we publicly prove our AI arbitration is accurate when
> there's nobody outside Arbitova grading it?**

Same question (public accountability for ruling quality),
different measurement surface.

---

## The new problem

Without an external grader, the available signals are:

1. **Internal re-audit rate.** Arbitova ops periodically sample
   past rulings and have a human re-judge them. The rate at
   which the re-audit disagrees with the original ruling is our
   quality signal. **But we're grading our own homework.**
2. **Party-satisfaction signal.** Post-dispute survey of the
   winning and losing party. Cheap; noisy; skewed toward people
   who respond.
3. **Appeal request rate.** Even without a formal appeal, we
   can expose a "request human review" button. The rate at
   which this button is pressed is a signal, but it's also
   trivially abusable by a losing party.
4. **Public contested-case ledger.** Every ruling is on-chain.
   Anyone can inspect reasoning text + verdict + votes ensemble
   data. Nobody has to trust our aggregate numbers because the
   raw data is verifiable.

The challenge: we need a posture that uses these signals
**honestly** — not one that lets us spin them.

---

## Three options

### (a) Per-case public — every ruling, reasoning, and internal audit result visible

We publish a public dashboard at `arbitova.com/verdicts` that
shows every dispute, its verdict, the AI reasoning, the ensemble
vote breakdown, and any re-audit result. Anyone can query any
case.

**Pros:**
- Maximally verifiable. Users don't have to trust our
  aggregate numbers because they can build their own.
- Matches our brand claim ("everything can be verified").
- Internal re-audits that disagree with original rulings are
  public, which is honest.
- Creates a strong alignment: if our first ruling is wrong and
  our re-audit catches it, there is a natural story to tell
  publicly.

**Cons:**
- Parties may object to their disputes being searchable.
  GDPR-adjacent (though all data is already on-chain; we're
  just indexing it).
- Early-stage: the first 5 disputes carry disproportionate
  weight in every aggregate anyone computes from our ledger.
- Cherry-picking risk: a competitor can post any single bad
  ruling on Twitter without context. We can't stop that.
- No external grader means "bad ruling" is itself a contested
  judgment. A disputed loser can always claim we ruled wrongly.

---

### (b) Quarterly aggregate public + internal audit disclosure

Arbitova publishes a quarterly transparency report with:

- Total cases arbitrated
- Internal re-audit rate (we sample X% of rulings, human
  re-judges, disagreement rate is published)
- Per-bucket breakdown (escrow size, dispute type, confidence
  band)
- Escalation rate (cases that hit the low-confidence gate and
  got human review before ruling, vs cases that went straight
  through)
- **Pre-committed gate:** if internal disagreement rate on the
  sample exceeds **10%**, we publish a root-cause dev log
  within 30 days.

Raw on-chain data remains queryable. We don't ship a per-case
search UI; people who want one build it themselves.

**Pros:**
- Aggregation damps noise from a tiny early sample.
- Internal audit rate is the honest version of "reversal
  rate" — still grades our work, just without a third party.
- Pre-committed gate is an accountability mechanism with
  teeth. You can't quietly change a number you declared
  would trigger action.
- Standard practice in regulated finance (SEC, central bank
  transparency cadence).

**Cons:**
- Internal audit is "grading our own homework." We have to
  credibly show the auditors are independent of the original
  rulers — either by hiring outside audit firms (real cost)
  or by publishing the audit methodology in enough detail
  that people can assess it.
- "Why not per-case?" is still a fair critique and we have
  to answer it. Answer: aggregation reduces cherry-picking;
  raw data is still on-chain for anyone who wants to
  reconstruct per-case.
- Quarterly cadence is slow for a high-trust signal. If
  something goes wrong mid-quarter, we have up to 3 months
  of opacity.

---

### (c) Hybrid — per-case on-chain data + quarterly aggregate report + no UI we maintain

We don't build a verdict-browsing UI. We don't publish a
per-case dashboard. We do:

1. Emit all ruling data as structured on-chain events (already
   doing this).
2. Publish a quarterly aggregate report (same as b).
3. Let third parties (Dune, Nansen, hobbyists, journalists)
   build whatever per-case search tooling they want on top
   of our event data.

**Pros:**
- We're not on the hook for maintaining a dashboard that our
  own brand stakes against.
- The per-case data exists for anyone who wants it. We're not
  hiding.
- Gives us the shape of (b) with zero additional UI
  engineering.

**Cons:**
- "Arbitova doesn't even publish their own rulings" is an
  unkind but not inaccurate framing a critic could use.
- Relies on ecosystem tooling to exist. If nobody builds a
  Dune dashboard for our events, the per-case data is
  effectively unfindable even though it's technically public.
- Looks lazy. We're leaving the hard surface to others.

---

## Recommendation

**(b) Quarterly aggregate public with internal audit + 10% gate.**

Concretely:

1. Arbitova commits to a **10% sample rate** of all rulings for
   internal re-audit. Re-audit is performed by a different
   operations person (minimum: different from the original
   ruler; ideal: an external contracted arbitrator we pay by
   the case once volume supports it).
2. Quarterly report at `arbitova.com/transparency/{year}-Q{n}`
   starting the first quarter after v1 mainnet launch.
3. Report publishes: total cases, sample size, internal
   disagreement rate, and a per-bucket breakdown.
4. **Pre-committed gate: if internal disagreement rate exceeds
   10%**, we publish a public root-cause dev log within 30 days
   explaining what the re-audits caught and what we're
   changing.
5. Raw on-chain data (verdict, reasoning text, vote ensemble
   snapshot, escalation flags) is emitted as structured events
   already (via `arbitration_verdicts` table + indexer). We
   don't promise a search UI; we do promise the event schema
   is stable and documented so third parties can build one.

**Why 10% gate, not 15%?**

The original two-tier brief suggested 15% (matching real-world
appellate-court reversal rates). But that was measuring
*disagreement with an independent party*. Internal re-audit
disagreement rate should be **lower** than external reversal
rate — if our own team re-reading our own rulings disagrees 15%
of the time, our consistency is too poor. 10% is a tighter
and more honest bar for an internal-only signal.

**Why quarterly, not real-time?**

With n < 100 cases, real-time publication produces meaningless
numbers. Quarterly gives us enough sample that the number
communicates something. Once volume is high enough that monthly
numbers stabilize, we can tighten cadence — that's a later
decision, not a v1 commitment.

**Why recommend (b) over (a)?**

(a) is more transparent in theory. In practice, at n=5 cases,
per-case publication is a weapon waiting for a critic to pick
up. (b) + raw-event access gives users all the data they need
while not pre-packaging attacks against us.

**Why not (c)?**

(c) optimizes our workload. (b) optimizes user trust. We're
pre-product-market-fit; optimizing user trust is the higher
priority.

---

## Decision record

- [ ] Founder choice: ______  (a / b / c)
- [ ] Date: ______
- [ ] Rationale if different from recommendation: ______
- [ ] Follow-up: draft `docs/transparency-policy.md` codifying
      the quarterly report structure, the 10% gate, and the
      sample methodology
- [ ] Follow-up: reserve `arbitova.com/transparency/` URL path
      in the site routing config
- [ ] Follow-up: add re-audit workflow to ops runbook
      (who audits, on what sample, documented how)
- [ ] Follow-up: decide if/when to move re-audits to an
      external contracted auditor (cost + credibility trade-off,
      revisit at 500 rulings)
