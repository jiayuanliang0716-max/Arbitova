# M-2 Decision Brief: Reversal-Rate Transparency Posture

Status: **AWAITING FOUNDER DECISION** (blocks Phase 4 Sepolia deploy of two-tier)
Source audit finding: `docs/remediation-plan.md` row M-2
Date: 2026-04-23

---

## The problem in one paragraph

"Reversal rate" = (cases where Kleros ruling ≠ Arbitova first-instance
ruling) / (total appealed cases). This number is the single most
important public-facing quality signal Arbitova has: it's a direct
measurement of how often our AI pipeline is wrong, graded by an
independent party we did not pick. If we publish it, it's also the
number a competitor or a critic will cherry-pick to attack us. If we
hide it, the "everything is verifiable" brand claim becomes
hypocritical (we publish rulings, but not our accuracy). Goodhart's
Law warns that any published metric that's tied to reputation gets
optimized against — if we publish a per-case reversal stat, we
create an incentive for Arbitova operations to discourage appeals
(subtle UX friction, delayed responses to appeal requests) to keep
the number low. **The policy we choose now locks in a behavioral
bias for the whole company.**

---

## Three options

### (a) Per-case public — every verdict and reversal visible on-chain and indexed

The indexer already emits `FirstInstanceResolved` and `AppealRuling`
events; we expose them verbatim in a public dashboard at
`arbitova.com/verdicts`. Anyone can query any dispute ID and see
both rulings side-by-side, plus the reversal flag.

**Pros:**
- Maximally transparent. Brand-consistent with "everything can be
  verified."
- Removes our ability to spin the data — critics can reconstruct
  the reversal rate themselves. Pre-empts accusations of
  cherry-picking.
- Strong marketing asset: a trusted public ledger of rulings is
  unusual in the arbitration space.

**Cons:**
- Early-stage noise is catastrophic. If the first 10 appealed
  cases include 3 reversals (30% reversal rate), that's a
  statistically insignificant sample but a viscerally bad
  headline. We have no way to correct the narrative.
- Makes every individual reversal a named, queryable PR event.
  Competitors can tweet "Arbitova was wrong on dispute #47 —
  proof here" without context.
- Parties to a dispute may object to their case being publicly
  searchable. GDPR-adjacent concern if any PII leaks into a
  ruling text.
- Goodhart risk is **maximal**: every Arbitova employee knows
  any reversal is a public strike against them. This pressure
  to avoid reversals produces the worst possible incentive
  structure — discouraging appeals.

---

### (b) Quarterly aggregate public — buckets by type + size

Every quarter, we publish a public report:
- Total cases arbitrated
- Total cases appealed (absolute + %)
- Reversal rate, bucketed by escrow size ($0–100 / $100–1k / $1k+)
- Reversal rate, bucketed by dispute type (delivery / quality /
  scope)
- Major-category breakdown of *why* reversals happened (root-cause
  tags)

No individual case is named in the aggregate report. The underlying
events are still on-chain (Kleros publishes its rulings) but we
don't maintain a per-case search UI.

**Pros:**
- Aggregation damps statistical noise. 30% reversal rate over 10
  cases becomes "reversal rate still forming, sample size 10" in
  the Q1 report.
- Gives us a narrative surface: we can commit in writing to
  "quarterly report with root-cause analysis" — trust-building
  without sacrificing discretion on individual cases.
- Standard practice in financial regulation (SEC filings,
  central bank transparency reports). Operators of critical
  infrastructure publishing aggregated performance data is
  uncontroversial.
- Goodhart risk is **moderate**: aggregate pressure, not per-case
  pressure. Still present but less acute.

**Cons:**
- "Why didn't you publish case-by-case?" is a fair critique and
  we have to answer it. The answer — "to reduce noise and
  adversarial cherry-picking" — is defensible but requires an
  operator who's willing to stand behind it.
- A determined critic can still query Kleros for appeal rulings
  and our contract for first-instance rulings, and reconstruct
  the per-case data themselves. We don't prevent that; we just
  don't pre-aggregate it into a weapon.

---

### (c) Internal dashboard + annual public report

Quarterly reversal-rate data stays internal (Arbitova team +
auditors). Once per year, we publish an annual transparency report
with the same bucketing as option (b).

**Pros:**
- Maximum protection against short-term noise and adversarial
  framing.
- Matches traditional arbitration body practice (AAA, ICC publish
  annual reports, not quarterly stats).

**Cons:**
- Visibly weaker than (b) on the verifiability brand axis. "We
  publish annually" reads as evasive in a crypto-native context
  where users expect real-time proof.
- Gives Arbitova a full year to quietly adjust operations before
  any signal becomes public. This is exactly the opacity the
  remediation audit flagged as reputationally fragile.
- Goodhart risk is **paradoxically the worst**: an internal
  metric with annual external exposure creates 11 months of
  pressure to "get the number down" before the annual report,
  which is the exact Goodhart failure mode.

---

## Recommendation

**(b) Quarterly aggregate public, with a pre-committed accountability
gate.**

Concretely:

1. Arbitova publishes a quarterly transparency report at
   `arbitova.com/transparency/{year}-Q{n}` starting Q1 2027 (first
   real quarter post-mainnet).
2. Report contents are fixed in advance: total volume, appeal rate,
   reversal rate (aggregated by size and type), root-cause
   categorization of reversals.
3. **Pre-committed gate:** if quarterly reversal rate exceeds **15%**,
   Arbitova publishes a root-cause dev log within 30 days describing
   what's changing in the pipeline. This gate is declared publicly
   *now* so it can't be quietly removed later.
4. Raw Kleros + Arbitova events remain on-chain (by definition — we
   don't control Kleros). Anyone can reconstruct per-case data. We
   just don't build a search UI that invites adversarial queries.

Reasoning:

- **(a) is too exposed pre-PMF.** We have zero volume today. The
  first five appealed cases will produce a meaningless reversal
  rate that lives forever in search results. Shipping (a) at this
  stage is "speedrunning a bad headline."
- **(c) is incompatible with our own brand claim.** We market as a
  verifiable system; an annual-only cadence reads as "trust us
  between reports."
- **(b) is the only option that's both defensible on brand and
  survivable on narrative risk.** It also matches the strongest
  real-world analogue: central bank and SEC transparency practice
  is quarterly + pre-committed methodology.
- **The 15% gate is the critical part.** Without it, (b) is
  "publish a number and hope people think it's good." With it,
  we have a public pre-commitment that if we cross a threshold,
  we owe an explanation. That's the accountability mechanism.

**Why not lower than 15%?** Real-world appellate-court reversal
rates range 8–15% depending on jurisdiction (federal circuit
reversals hover around 8–10%; state appeals courts run higher).
A 15% gate is slightly above the top of the normal range — high
enough that hitting it is a real signal, low enough that hiding
behind "15% is within norms" isn't credible.

**Why not higher than 15%?** A gate above 20% becomes a figleaf.
If reversal rate is 18% we'd still want to explain why.

---

## Decision record

- [ ] Founder choice: ______  (a / b / c)
- [ ] Date: ______
- [ ] Rationale if different from recommendation: ______
- [ ] Follow-up: update `two-tier-arbitration-design.md` D-3 section
  to state the chosen posture
- [ ] Follow-up: draft `docs/transparency-policy.md` codifying the
  quarterly report structure and the 15% gate (if (b) is chosen)
- [ ] Follow-up: reserve `arbitova.com/transparency/` URL path in
  the site routing config
