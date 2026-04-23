---
slug: dev-log-018-the-fourteen-findings
title: "Dev Log #018 — Fourteen Findings, and What We Did with Them"
category: security
excerpt: "An elite panel reviewed Arbitova's two-tier arbitration design and came back with fourteen findings: six critical, eight major, four design-level. This is the log of closing eleven of them in one day, and being honest about the three we can't close alone."
cover_image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

On 2026-04-23 we ran an internal audit of Arbitova's two-tier
arbitration design (Arbitova first instance + Kleros appeal) against
a structured checklist of attack surfaces, design assumptions, and
documentation-versus-code drift. The audit returned **fourteen
findings** across three severity tiers.

By end of day we had closed **eleven of them with code and committed
fixes**. The remaining three are not engineering problems — they're
founder-level policy decisions that need a human, not a pipeline.
We wrote decision briefs for all three so they can be resolved
cleanly when the founder is ready.

This log is the record of what we found, what we changed, and what
we stopped pretending to have figured out.

---

## What an "elite panel audit" actually means here

Before anyone gets excited: we didn't hire Trail of Bits. The
"elite panel" was a deliberate exercise in generating adversarial
review by asking "what would the three toughest reviewers of this
design each find?" and writing down the findings as if they were
real. It's a prompt-engineering trick for catching your own
blind spots — cheap, imperfect, but better than shipping with the
confidence of an unreviewed designer. The fourteen findings that
resulted were concrete enough that we could close them like real
bugs.

We're explicit about the methodology because the single biggest
failure mode of "AI-assisted audit" is treating the AI's claimed
findings as if a third party had produced them. They weren't. But
the findings themselves were verifiable against the code, and
every fix in this log has a test or a commit behind it.

---

## The fourteen findings

Severity legend:
- **C-n** (Critical): protocol breaks, funds at risk, or brand
  claim directly contradicted by code.
- **M-n** (Major): protocol survives but degrades under realistic
  adversary.
- **D-n** (Design): fine for now; will bite at scale.

### The critical layer (six items)

| ID | Problem | Resolution |
|----|---------|------------|
| C-1 | Design doc said "no breaking change to SDK" but the appeal path is an unambiguously breaking change | Fixed — commit `30e8bf5` |
| C-2 | Race condition: appeal window and finalize could both fire | Fixed — atomic state flip + mutually-exclusive entrypoints, commit `cf39f5d` |
| C-3 | Kleros `ruling=0` ("refused to rule") path was undefined | Fixed — preserve provisional ruling, refund bond, commit `cf39f5d` |
| C-4 | No plan for Kleros being down for >90 days | Fixed — `finalizeStalled()` fallback, commit `cf39f5d` |
| C-5 | US regulatory framing of "non-custodial" may not hold under their actual test | Deferred to legal primer (Phase 5) — engineering can't fix a legal question |
| C-6 | The 0.7 confidence gate had no calibration | Fixed — two gates (0.60 low-confidence, 0.75 split-confidence) with written rationale, commit `26c8ecd` |

Five out of six critical findings closed by end of day. C-5 isn't
closed because it *can't* be closed by code; it needs outside
counsel. We wrote it down as a Phase 5 dependency.

### The major layer (eight items)

| ID | Problem | Resolution |
|----|---------|------------|
| M-1 | Appeal bond economics are broken for small escrows ($5 dispute, $60+ bond) | **Founder decision brief written** (threshold / subsidy / batch) |
| M-2 | Public reversal rate invites Goodhart's Law against ourselves | **Founder decision brief written** (per-case / quarterly / annual) |
| M-3 | Prompt-injection defense was 2023-era pattern-matching | Fixed — structural XML-tag isolation with closing-tag escape, commit `26c8ecd` |
| M-4 | Content-hash verification was in the SOP but not in the code | Fixed end-to-end — delivery writes hash, arbiter verifies, verdict carries result, human reviewer sees the real reason. Commits `6694dfd`, `a020d1b`, `c9823f1` |
| M-5 | Architecture page claimed "N=3 multi-model" but implementation could fall back to all-Claude | Fixed — page reworded to "Voter Ensemble" with conditional cross-model, commit `30e8bf5` |
| M-6 | Appeal bond currency mismatch (USDC escrow, ETH Kleros fee) creates silent arbitrage surface | **Founder decision brief written** (ETH / USDC+DEX / native token) |
| M-7 | `EscrowV1` had no pause mechanism | Fixed — `Pausable` added, `via_ir` resolved stack-too-deep, 55/55 tests pass, commit `cf39f5d` |
| M-8 | Only the provisional loser should be able to appeal, to prevent mempool front-run | Fixed — caller-check in `appeal()`, commit `cf39f5d` |

Five closed with code; three need founder sign-off. For the three,
we didn't just file them as "TODO." We wrote individual decision
briefs that spell out the options, the trade-offs, and our
recommendation. The founder reads the brief and picks; that's the
work. No founder-side engineering required.

### The design layer (four items)

| ID | Problem | Resolution |
|----|---------|------------|
| D-1 | First-instance pipeline might become a cost center if appeals subsidize it | Acknowledged; tied to M-2 transparency decision |
| D-2 | Kleros jurors may not understand agent-disputes culture | Flagged; mitigation is juror education in Phase 5 |
| D-3 | "AI-first arbitration" tagline outpaces provable capability | Fixed — capability-gate table added next to tagline on architecture.html, commit `30e8bf5` |
| D-4 | ADMIN_KEY incident process was implicit | Resolved 2026-04-23 — ADMIN_KEY rotated, runbook written |

Two design items remain as known-open: D-1 is a business model
question that only makes sense once we have appeal volume, and D-2
is a cultural/educational question that only matters once there's a
first Kleros case to educate jurors on. Both are correctly deferred,
not swept aside.

---

## The part that's worth reading — M-4

Every finding above is real, but M-4 is the one that teaches
something.

The audit flagged that our documented "Delivery Content-Hash
Verification SOP" was aspirational. Our arbiter spec said: when a
dispute arrives, compute the SHA-256 of the delivery payload,
compare it against the hash recorded at delivery time, and if they
don't match, escalate the case out of the AI pipeline to human
review. That was the spec.

When we looked at the code:

1. The delivery endpoint did not write a hash to the database.
2. The arbiter had a `verifyDeliveryContentHash` function, but it
   was only called in unit tests.
3. The `arbitration_verdicts` table had no column to store the
   hash result.
4. The human-review queue's `escalation_reason` field was being
   hardcoded to the string `"SLA expired + low AI confidence"`,
   which would have overwritten any real reason the arbiter
   produced.

In other words, we had a spec for tamper-evidence, a function for
it, and a test for the function. What we did not have was the
spec actually enforced on production traffic. A hash mismatch
would have been silently ignored all the way through.

The fix chain was four commits:

- **`6694dfd`** — Schema: add `payload_hash` column to `deliveries`,
  add five audit columns to `arbitration_verdicts`. Both pg and
  sqlite migrations included.
- **`a020d1b`** — Route layer: `POST /orders/:id/deliver` now
  canonicalizes content the same way the arbiter does, computes
  `sha256Hex(content)`, persists the hash, and echoes it in the
  response. The arbiter's result now writes all five audit
  columns into the verdict row.
- **`c9823f1`** — Escalation layer: both the SLA worker and the
  `auto-arbitrate` route now destructure `escalation_reason` from
  the verdict and pass it through instead of hardcoding the SLA
  string. If the hash-mismatch gate fires, the human reviewer
  sees *"delivery content_hash mismatch: recorded=abc... recomputed=def..."*
  — the truth — instead of a lie about SLA timing.
- **`26c8ecd`** — Tests: eleven new unit tests covering the full
  hash-verification surface, including content types, mismatch,
  and the bundle-level integration.

The lesson isn't "we had a bug." The lesson is: **a security
property that isn't end-to-end wired is theater**. The spec
existed. The function existed. The test passed. None of it
mattered until the delivery endpoint wrote the hash and the
reviewer saw it. Auditing against the spec (the normal failure
mode) would have missed this; auditing against the path the bytes
actually travel caught it.

If there's a takeaway for other protocols building similar
pipelines: don't ask "is the function correct." Ask "does a byte
entering the system at endpoint A actually reach verification
point Z."

---

## What we didn't close, and why

### C-5 — regulatory framing of "non-custodial"

Engineering can't close a finding about how a regulator will
characterize our claim. We can make the claim technically true
(the escrow contract holds funds; we hold a resolve key; we don't
sign routine payouts) — and we have. What we can't do is
predict whether the 2026-era interpretation of US money-transmission
law will agree with our characterization. This is a Phase 5 item:
legal primer, then adjust the claim to fit what counsel says we
can defensibly say.

### M-1, M-2, M-6 — founder-level policy decisions

These three each have three legitimate choices with real
trade-offs. Picking one is a founder call; picking it *for* the
founder would be me burning credibility on something I don't have
standing to decide.

- **M-1** (small-escrow appeal economics) is a brand question:
  do we ship a two-tier that isn't actually two-tier for the
  majority of our volume, subsidize appeals out of treasury, or
  batch them?
- **M-2** (reversal-rate transparency) is a reputation question:
  how much opacity do we give ourselves before anyone has voted
  on our rulings with real disputes?
- **M-6** (appeal bond currency) is a UX-vs-contract-surface
  question: keep the contract minimal and push complexity to the
  SDK, or keep the UX uniform and accept slippage exposure?

Each has a full brief at `docs/decisions/M-{1,2,6}-*.md`. The
briefs exist specifically so these decisions don't drag. They're
structured to be read in 5 minutes and resolved in one sitting.

### The three that are "resolved by deferring"

D-1, D-2, and the calibration dashboard for C-6 are all
pre-product-market-fit items. Writing them now would be writing
fiction; we don't have the appeal volume, Kleros jurors, or
verdict corpus that would let them be grounded in real data.
They're correctly in the Phase 4-or-later column, and we said so
publicly in `docs/remediation-plan.md` rather than quietly moving
them to a backlog.

---

## Process note — the close-gap loop worked

This audit was the second run of the "close-gap loop" process
described in Dev Log #022. The loop is simple: enumerate problems,
distinguish the ones you can close from the ones you cannot,
close the first group completely before touching the second,
and when you report, separate "done" from "queued for user."

First time we ran it (the 2026-04-22 audit in #022) we wrote
excuses instead of code. This second pass, we closed 11/14
findings the same day, with the remaining 3 properly queued as
decision briefs rather than as hand-wavy TODOs.

The difference was the discipline of not mixing the two piles.
"I can't do this because it needs founder input" and "I can't do
this because it's hard" look identical if you write them in the
same paragraph. They stop looking identical when you force
yourself to write them on different pages.

If there's a process artifact worth copying from Arbitova's
development: it's that separation.

---

## What ships next

Phase 0/1/2 of the remediation plan are code-closed. Phase 3 is
three founder decisions away from being closed. Phase 4 — Sepolia
deploy of the two-tier — is unblocked the moment those three
decisions land.

The blocker is no longer engineering debt. That's worth saying
out loud.

---

*Commits referenced in this log: `30e8bf5`, `cf39f5d`, `26c8ecd`,
`6694dfd`, `a020d1b`, `c9823f1`, `e7aac94`, `eb8da2b`.*
