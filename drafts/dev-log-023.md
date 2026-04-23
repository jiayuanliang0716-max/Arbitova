---
slug: dev-log-023-scoping-the-promise-down
title: "Dev Log #023 — Scoping the Transparency Promise Down on Day Two"
category: transparency
excerpt: "On 2026-04-23 I published Arbitova's transparency policy. It committed us to per-case verdict publication, a 10% internal re-audit sample by a second operator, and a rolling-30 disagreement gate that forces a public post-mortem if we breach. On 2026-04-24 I amended that policy to remove the re-audit half. This log is why, and what 'amending' actually looks like when the policy is 24 hours old."
cover_image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

Yesterday I wrote a transparency policy that promised two things: every dispute verdict public per-case, and a 10% re-audit of decisions by a different operator that feeds a rolling-30 gate.

Today I started writing the SOP behind the re-audit half. I got 192 lines into it before I hit the load-bearing sentence: *"reviewer `operator_id` must not equal the original verdict's `operator_id`."* Arbitova has one operator. That sentence wasn't SOP; it was fiction.

The founder's response when I raised this, verbatim: *"I don't think this is something we should be doing right now, cancel everything."* The policy was amended the same day. The v1.1 version in the repo now commits only to what the team can actually deliver — per-case publication — with the re-audit program removed in full and the amendment documented in the same policy document that used to promise it.

This log is the amendment record. The policy itself said *"any change must be proposed in a dev log with rationale and an explicit comparison to the old commitment"* — here it is.

## What the v1 policy promised (2026-04-23)

Three commitments, in rough order of staffing cost:

1. **Per-case publication.** Every verdict surfaced at `/verdicts/{disputeId}` with reasoning, vote breakdown, escalation flags, content-hash integrity data.
2. **10% re-audit sample.** A nightly job samples 10% of the prior day's verdicts (confidence-weighted toward the 0.60–0.75 band) and assigns each to a *different* operator for a second read. The re-audit result — agree / disagree / reasoning-holds-up — gets published alongside the original verdict on the same page.
3. **Rolling-30 disagreement gate.** If the internal disagreement rate on the last 30 re-audits exceeds 10%, a public root-cause dev log is published within 30 days explaining what the re-audits caught and what's changing in the arbitration pipeline.

Commitment #1 is deliverable with one person: it's a page template, a database query, an on-chain event listener. Commitments #2 and #3 are a staffed operation. They require, at minimum, a second human who is (a) independent of the primary arbiter, (b) not on the same on-call rotation, (c) reliable enough to sustain a nightly cadence. Without that second person, the SOP that executes the commitment reads as aspirational.

## What I did between 2026-04-23 evening and 2026-04-24 morning

Wrote `docs/arbiter-ops-runbook.md` §1. A nine-subsection, 192-line operational procedure covering:

- Nightly sampling cadence and RNG-seed logging.
- Confidence-weighted sample selection.
- Reviewer assignment rules (different `operator_id`, not on-call).
- Review packet contents (deliberately non-blind — calibration, not adversarial).
- Three-tier disagreement definition (winner-mismatch, split-delta > 20pp, reasoning-level error).
- `arbitration_reaudits` table schema.
- Rolling-30 gate monitor with `GATE_BREACH` alert and 30-day clock.
- Publication rules at `/verdicts/{disputeId}`.
- The engineering queue that has to ship before any of this runs.

It was a clean-looking document. It was clean-looking the way a dining-hall kitchen is clean-looking when the health inspector walks through and the equipment is new but the grease hasn't hit it yet. Nothing about the document tells you whether the staff exists to run the procedure it describes.

## Where the failure landed

The founder asked, in the afternoon: *"who does the re-audit? which human?"*

I wrote a staffing proposal. Four options — a founder-plus-one minimal version, a three-person part-time rotation, outsourcing to a dispute-resolution BPO, a community-jury MVP. I priced them. I recommended starting at option A and scaling to option B.

The founder's next message was: *"I don't think this is something we should be doing right now, cancel everything."*

That was correct. I had been so focused on how the SOP would execute *if staffed* that I hadn't weighed the alternative — not staffing it, and not promising it either. The v1 policy had been in force for less than 24 hours. The cost of amending on day two, while the ink was wet, was almost zero. The cost of leaving a commitment in place that we couldn't deliver on would have been enormous: the next post-audit disagreement would have surfaced the gap publicly, not privately.

## What v1.1 changes

The amendment is short. From the policy file:

> **2026-04-24 — re-audit program removed.** The original v1 policy (2026-04-23) committed Arbitova to a 10% sample re-audit of every verdict, executed by a second operator, with a pre-committed rolling-30 disagreement gate at 10% that would force a public root-cause dev log within 30 days on breach. The amendment removes this commitment in full. What changed between 2026-04-23 and 2026-04-24: the re-audit SOP was drafted and we confirmed it required a second operator Arbitova does not currently staff. Rather than keep a commitment we could not execute, we scoped the promise down to what the current team can deliver — per-case public publication — and removed the re-audit mechanism.

What was dropped:

- The 10% sample re-audit and its SOP (runbook §1 removed in full; the 192 lines live only in git history now).
- The rolling-30 gate and the 30-day public-post-mortem clock.
- The re-audit bundle in every per-case page.
- The "re-audited flag" column on `/verdicts`, the "re-audited-only" filter, the reviewer CLI that would have written to `arbitration_reaudits`.

What was kept:

- Per-case publication at `/verdicts/{disputeId}`, including full arbiter reasoning, ensemble vote breakdown, confidence, escalation flags, and content-hash integrity data.
- The consent disclosure at three surfaces (`@arbitova/sdk` JSDoc, `packages/sdk-js/README.md`, `public/pay/new.html`) — updated to match the new scope.
- The scope-note on `/verdicts` itself, which remains an acknowledgment that the full per-case bundle is Phase 4 engineering work, not already built.
- The "any change must be dev-logged" rule. This log is that rule working on itself.

## What this means in practice

For someone using Arbitova today: no change to the *what is published* on the happy path (nothing), and one change on the dispute path — the per-case page will show the arbiter's reasoning and votes, but it will not show a second opinion from a different operator. The AI ensemble's internal vote breakdown (three models voting, with their confidence scores visible) is the only quality signal this policy commits to.

For someone reading the policy: a v1.1 commitment that the team can demonstrably keep, instead of a v1 commitment with a staffing footnote that wasn't there. The amendment log sits at the bottom of the policy file and cannot be quietly removed without a further visible edit.

For Arbitova: one less operational dependency on hiring. The re-audit program can return — with attached staffing — in a future version if it earns its way back. "Earns its way back" meaning: we have the operator, we have a reason to spend their time, and we have the evidence that the arbiter produces enough low-confidence verdicts to warrant the check. None of those are currently true.

## What this isn't

Not a retreat on transparency. Per-case publication is still the strongest commitment any escrow protocol in the A2A space has made publicly. Aggregate reports, quarterly summaries, "we resolve 95% correctly" marketing — none of those are on the table. Every verdict still has a URL; every piece of reasoning still has a permanent home. A critic who wants to argue that Arbitova got a specific case wrong can still do it with a link, not an FOIA request.

Not a retreat on accountability. The founder is still the single point of failure on verdict issuance; the pause switch still exists; the consent disclosure still warns parties before they lock funds. What changed is we stopped promising a mechanism we couldn't execute.

Not a retreat on honesty. The opposite: shipping a v1 with an aspirational commitment and shipping a v1.1 that removes it is better than shipping a v1 that quietly doesn't happen. The amendment is public because the commitment was public. The log you're reading is the policy enforcing itself.

## What I should have done on 2026-04-23

Written v1 with only commitment #1 to begin with, and filed commitments #2 and #3 as design sketches pending staffing. That would have saved a day of SOP writing and a same-day amendment. The SOP wasn't wasted — it's in git history and it's the draft we'd pick up if and when the re-audit program returns — but shipping it as if it were live was premature.

Why I didn't: the transparency maximalist posture is attractive, and writing the stronger version of a commitment feels like the right move until you ask who executes it. I wrote the stronger version. The founder asked who executes it. I didn't have an answer. The only honest follow-up was the amendment.

The lesson isn't "don't make strong commitments." It's "don't commit to mechanisms whose first operational question isn't already answered." If the answer to *"who does this?"* is a staffing proposal written after the commitment, the commitment has no staffing. If it has no staffing, it's a wish, and wishes don't belong in a transparency policy.

## For the curious

- v1.1 policy: `docs/transparency-policy.md` (amendment log at bottom)
- v0.2 runbook: `docs/arbiter-ops-runbook.md` (§1 removed; amendment note at top)
- v1 policy: recoverable from `git log docs/transparency-policy.md` at commit preceding today
- v0.1 runbook: recoverable from `git log docs/arbiter-ops-runbook.md` at commit preceding today

Next log will be about something that ships, not something that unships. Promised.
