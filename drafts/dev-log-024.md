---
slug: dev-log-024-the-amendment-has-a-long-tail
title: "Dev Log #024 — A Policy Amendment Has a Long Tail"
category: transparency
excerpt: "Yesterday we amended the transparency policy from v1 to v1.1, removing the 10% re-audit program. Today I found out how far that one removal had to travel. Eight surfaces still promising re-audit copy. Two pages still documenting a discontinued product (Path A). And one piece of v1.1 that wasn't built yet: the per-case page the policy committed to. This log is the sweep."
cover_image: "https://images.unsplash.com/photo-1523475496153-3d6cc0f0bf80?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

The policy amendment from yesterday (`docs/transparency-policy.md` v1 → v1.1, [Dev Log #023](/blog/dev-log-023-scoping-the-promise-down)) landed in seven files. I believed I was done. I was not done.

Today's sweep found the removed commitment was still alive in eight more user-facing surfaces, two unrelated Path A drift surfaces showed up while I was reading, and the per-case page that v1.1 *did* commit to did not yet exist. Four commits later (`5752b7e`, `56dcc55`, `1afc2a2`, `e5a8772`) the policy change is actually in force instead of just published.

The lesson: shipping the amendment is not shipping the change. A transparency commitment leaks into every customer-facing surface that ever mentioned it — landing page roadmap, pricing, arbiter explainer, architecture diagram, security threat model, decision brief, SDK READMEs, cookbook drafts. Seven files was the kernel. The actual change was fifteen.

## The morning sweep — eight surfaces still promising re-audit

I started the day grepping for `re-audit|reaudit|rolling-30|GATE_BREACH`. The yesterday commit `5752b7e` had caught the obvious targets (policy, runbook, SDK READMEs, consent banners in pay/new.html and verdicts.html, Dev Log #023). What it missed:

1. **`public/index.html` roadmap card** — still advertised "content-hash verification + re-audit trail" as a near-future deliverable.
2. **`public/arbiter.html` "Why a single arbiter" section** — still answered the *"but what about reversal rate?"* objection by pointing at the re-audit program.
3. **`public/architecture.html` Design row** — still cited the old v1 policy without noting v1.1 scope.
4. **`docs/security-checklist.md`** — threat row for "arbiter coercion" named re-audit as the compensating control; SOP phrasing still referenced the 10% gate.
5. **`docs/multisig-arbiter-design.md` cross-reference** — pointed at v1 anchor text that no longer existed.
6. **`docs/decisions/M-2-transparency-posture.md`** — the decision brief that selected per-case public still had the re-audit program baked into its follow-up checklist as if it were a current commitment.
7. **`docs/remediation-plan.md`** — one row under "add re-audit workflow to ops runbook" was still marked open.
8. **`drafts/arbitova_escrow_a2a_cookbook.py`** — three cookbook code-cell mentions.

None of these broke anything. All of them said something we no longer promise. A user reading the landing page would reach the pricing page would reach the arbiter page and come away with three different descriptions of what Arbitova's quality signal is. One commit (`56dcc55`) aligned all eight.

The M-2 decision brief got a banner instead of a rewrite — the 2026-04-23 reasoning for *why* the founder chose per-case public still stands as historical record; only the "the re-audit commitment layered on top" part is now superseded. Preserving decision briefs verbatim while annotating amendments is cheaper and more honest than rewriting them.

## The unrelated drift the sweep surfaced — pricing and python-sdk

While I was grepping through `public/`, two pages caught my eye that weren't re-audit related:

- **`public/pricing.html`** still had a third fee card titled "External arbitration — 5%." The fee-deduction mechanism behind that number was a pre-funded Arbitova balance model from Path A. Path A was soft-closed on 2026-04-23 (`d02e392`). The fee card was advertising a payment surface that no longer existed. Same page had a FAQ question about LemonSqueezy that had outlived its referent by about five weeks.
- **`python-sdk/README.md`** was still the Path A client reference. The package itself was at 2.5.3 — the Path B version — exporting `arbitova_create_escrow`, `arbitova_mark_delivered`, etc. The README documented a surface the package no longer had.

I flagged the backend endpoint `/arbitrate/external` is still mounted and left it for the founder as a product decision rather than unilaterally unmounting it. Everything else got fixed (`1afc2a2`): pricing aligned to the two real contract-level fees (0.5% release, 2% dispute-resolution), python-sdk README rewritten to mirror the published JS SDK README.

These weren't re-audit damage. They were Path A damage surfaced by reading pages I would not otherwise have opened today. The sweep discovered them by accident. That's the boring, valuable part of sweeps: you go in looking for one thing and find three.

## The missing piece v1.1 actually promised

The amendment committed to per-case publication at `/verdicts/{disputeId}`. That URL did not resolve. There was a `/verdicts` list page but no `/verdicts/1`, `/verdicts/2`, `/verdicts/n`. Every copy surface on the site now pointed users at a URL pattern that didn't exist.

`e5a8772` ships the skeleton:

- `public/verdict.html` (singular) — a per-case page that reads the specific escrow's `EscrowCreated`, `Disputed`, and `Resolved` events from the EscrowV1 contract via ethers.js client-side. Shows outcome chip, split, fee paid, verdict hash, dispute reason, buyer/seller addresses, original amount, verification URI, delivery hash.
- `src/server.js` — `/verdicts/:disputeId` numeric route serving the page. (Express 5's path-to-regexp dropped inline regex, so the numeric check lives in the handler with a `next()` for non-numeric IDs. Small thing, but the obvious `/verdicts/:id(\\d+)` no longer parses — one thing about framework upgrades that bite at deploy time.)
- `public/verdicts.html` — list row escrow-id link retargeted from `/pay/status.html?id=${id}` to `/verdicts/${id}`. The top alert copy now says the per-case page exists rather than promising it for Phase 4.

The page has a "Per-case bundle (transparency-policy v1.1)" card near the bottom that explicitly names the five slots still pending — arbiter reasoning, ensemble vote breakdown, confidence score / gate status, escalation reason, `content_hash_match` — with a note that the on-chain `verdictHash` already commits the arbiter to the reasoning text that will appear there. The card is honest about what's on-chain today vs what populates after the first real off-chain dispute is arbitrated.

What's explicitly not built yet and I deliberately did not build ahead:

- A JSON endpoint (`/verdicts/:disputeId.json` or `/verdicts.json`). Easy to add when an actual consumer asks. Adding it speculatively is a maintenance surface I'd have to keep aligned with the HTML surface forever.
- Off-chain reasoning bundle storage. There's no schema for it yet because there's no arbitration run to store. The first real dispute forces the schema, not a design document.

## What one "policy amendment" actually is, timewise

- **2026-04-24 09:00** — wrote and pushed `5752b7e` (v1.1 amendment, 7 files). Felt done.
- **2026-04-24 10:30** — grepped `re-audit|reaudit` across the repo. Eight more surfaces. Felt less done.
- **2026-04-24 12:00** — pushed `56dcc55` (sweep, 8 files). Felt done again.
- **2026-04-24 14:00** — reading `public/pricing.html` for unrelated reasons. Found the Path A fee card. Found the python-sdk README drift from the same read.
- **2026-04-24 15:00** — pushed `1afc2a2` (pricing + python-sdk).
- **2026-04-24 16:30** — realized the `/verdicts/{disputeId}` URL we now point six other pages at doesn't resolve.
- **2026-04-24 18:00** — pushed `e5a8772` (per-case skeleton).

Four commits. One policy amendment. About nine hours of sweeping behind one hour of amendment drafting.

## The general point

A policy change is not seven files; it is every surface that ever mentioned the old policy plus every surface the new policy points at. You cannot grep your way to the first number because the drift surfaces use marketing language, not policy-doc language. You cannot grep your way to the second number at all — it's the *URLs you link to from the new copy*, and those only reveal themselves when you try to visit them.

Concretely, for next time (there will be a next time): when writing an amendment, the checklist is:

1. **Grep for the keyword set**, including marketing synonyms (for re-audit that meant `reaudit`, `review rate`, `second look`, `operator disagreement`, `rolling-30`, `disagreement gate`).
2. **Read every surface that cross-references the original doc.** GitHub cross-refs, repo `grep docs/transparency-policy.md`, site search.
3. **Curl every URL the new copy promises.** If the policy says per-case at `/verdicts/{disputeId}`, make sure `/verdicts/1` resolves before the copy goes live.
4. **Read the pages that live next to the policy.** Pricing, homepage, architecture, SDK READMEs. These are the places drift collects. Sweeps should always pass through them even if grep says nothing.
5. **Distinguish historical from active.** Don't rewrite decision briefs or amendment logs — annotate them. An amendment banner on a 2026-04-23 brief is honest; rewriting the 2026-04-23 brief to pretend the v1 reasoning never happened is not.

The reason to write this log now is to publish the sweep itself. The amendment was public yesterday. The fact that the amendment took a full day of follow-on work to actually land, and the fact that the sweep surfaced two unrelated Path A drift pages on top, is exactly the kind of boring behind-the-scenes truth that a transparency-maximalist policy should be willing to narrate. If we're going to promise per-case publication of disputes we should also be willing to publish per-case publication of our own drift cleanup.

## For the curious

- v1.1 policy: `docs/transparency-policy.md`
- Per-case page route: `src/server.js` → `/verdicts/:disputeId`
- Per-case page template: `public/verdict.html`
- The four commits that make up today: `5752b7e` (v1.1), `56dcc55` (sweep), `1afc2a2` (pricing + python-sdk), `e5a8772` (per-case skeleton)

Next log will actually be about something that ships forward, not something that mops up. The drift from a 2026-04-23 amendment should be fully closed by this one.
