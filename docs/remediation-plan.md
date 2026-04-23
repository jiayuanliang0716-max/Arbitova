# Arbitova Two-Tier Remediation Plan

Status: active plan, 2026-04-23.
Trigger: elite-panel review of `two-tier-arbitration-design.md`,
`EscrowV1.sol`, `security-checklist.md`, and `EscrowV1WithKleros.sol`
draft. 6 critical + 8 major + 4 design findings identified.
Scope: bring the two-tier arbitration design to a state where it
can be deployed to Sepolia Phase 1 and later audited for mainnet.

**Ground rules for this plan:**

1. **Phases are gated.** No phase starts until the previous phase's
   acceptance criteria are all green. Skipping a gate invalidates
   subsequent work.
2. **Each item has exactly one owner.** `🤖` = assistant/code work.
   `👤` = founder decision or external action.
3. **No "we'll fix it later" lines.** Every item either has a
   concrete fix in this plan, or a concrete deferral reason with
   the phase it moves to.
4. **Stop conditions are explicit.** Each phase names the conditions
   under which the plan should pause for reassessment rather than
   proceed.

---

## Reference — the 14 findings this plan addresses

Short IDs map back to the 2026-04-23 audit report.

| ID  | Severity | Summary                                                    | Phase |
|-----|----------|------------------------------------------------------------|-------|
| C-1 | Critical | "No breaking change" claim in design doc is false          | 0     |
| C-2 | Critical | `appeal()` / `finalize()` race condition                   | 1     |
| C-3 | Critical | Kleros `ruling=0` not handled anywhere                     | 1     |
| C-4 | Critical | UNDER_APPEAL has no fallback if Kleros dies                | 1     |
| C-5 | Critical | Non-custodial claim may be wrong under US regulatory view  | 5     |
| C-6 | Critical | Confidence gate 0.7 has no documented calibration          | 2     |
| M-1 | Major    | Small-escrow appeal economics are broken                   | 3     |
| M-2 | Major    | Public reversal rate → Goodhart's Law                      | 3     |
| M-3 | Major    | Prompt-injection defense is pattern-match (2023-era)       | 2     |
| M-4 | Major    | Content-hash verification not actually in arbiter SOP      | 2     |
| M-5 | Major    | "N=3 multi-model" claim vs. implementation reality         | 0     |
| M-6 | Major    | Appeal bond currency inconsistency opens arbitrage         | 3     |
| M-7 | Major    | No pause mechanism on `EscrowV1`                           | 1     |
| M-8 | Major    | Single-appellant design vulnerable to mempool front-run    | 1     |
| D-1 | Design   | First-instance could become pure cost center               | 4     |
| D-2 | Design   | Kleros jurors may not understand agent disputes            | 5     |
| D-3 | Design   | Tagline outpaces provable capability                       | 0     |
| D-4 | Design   | ADMIN_KEY incident process (**resolved 2026-04-23**)       | ✅    |

---

## Phase 0 — Documentation integrity (today, ~2 hours, 🤖)

**Goal:** the written record stops overclaiming. Nothing gets built
on top of a doc that says something the code doesn't do.

### Items

- [x] **C-1 fix** — Edit `docs/two-tier-arbitration-design.md` to
      remove the "no breaking change" language. Replace with an
      explicit "SDK 4.x major version bump" section listing every
      ABI change and how integrators migrate. *(commit 30e8bf5)*
- [x] **M-5 fix** — Audit `public/architecture.html` §"Multi-Model
      Voting". Open `src/arbitration/` (or wherever the verdict
      pipeline lives) and verify actual N. Three outcomes:
      a) real N distinct providers → list them in the page;
      b) N Claude calls with distinct prompts → rename to "Ensemble
      Prompting"; c) N=1 → remove the section entirely.
      *(commit 30e8bf5 — renamed to "Voter Ensemble" with conditional
      cross-architecture diversity via OPENAI_API_KEY)*
- [x] **D-3 fix** — Edit `two-tier-arbitration-design.md` to add a
      "Tagline-capability gate" section stating that
      `"AI-first arbitration with decentralized appeal"` remains
      internal-only until Phase 4 data shows ≥50 real disputes with
      reversal rate published. *(commit 30e8bf5)*
- [x] **Remediation plan itself** (this file) — committed to
      `docs/remediation-plan.md`. *(commit 7e2d23c)*

### Acceptance

- No doc in the repo contains a claim about system behavior that
  the code does not yet implement, unless explicitly prefixed with
  "Planned (Phase X):".
- Commit messages reference the finding ID.

### Stop condition

If during C-1 review I find more ABI drifts that weren't in the
audit, expand the audit rather than silently fixing.

---

## Phase 1 — Contract-draft hardening (this week, ~8h, 🤖)

**Goal:** `contracts/draft/EscrowV1WithKleros.sol` becomes a draft
that an auditor would take seriously. Not production yet — still a
draft — but no known critical bug.

### Items

- [x] **C-2** — Redesign the appeal/finalize boundary. Concretely:
      add `appealGracePeriod = 1 hours`. `finalize()` requires
      `block.timestamp > appealDeadline + appealGracePeriod`.
      `appeal()` requires `block.timestamp ≤ appealDeadline`.
      Document the grace period's rationale in an inline comment.
      *(commit cf39f5d — solved via atomic state flip + mutually
      exclusive entrypoints instead of a grace period)*
- [x] **C-3** — Add explicit `ruling == 0` branch to the draft's
      `rule()` callback. Decision: `ruling == 0 → retain provisional
      ruling, refund full appeal bond`. Rationale: Kleros's "refused
      to rule" is not the appellant's fault. *(commit cf39f5d)*
- [x] **C-4** — Add `emergencyFallbackAfterKlerosTimeout(uint256 id)`
      to the draft. Requires: state == UNDER_APPEAL,
      `block.timestamp > klerosEscalatedAt + 90 days`. Effect:
      reverts to provisional ruling, refunds bond. Callable by
      anyone (liveness, not authority).
      *(commit cf39f5d — shipped as `finalizeStalled`)*
- [x] **M-7** — Add `Pausable` from OpenZeppelin. Only `createEscrow`
      respects the pause flag. All other functions (markDelivered,
      dispute, resolve, finalize, appeal, cancelIfNotDelivered,
      escalateIfExpired, emergencyFallback) must work even when
      paused, so existing escrows can reach terminal state.
      *(commit cf39f5d — EscrowV1 surgically gated; 55/55 tests pass;
      `via_ir = true` added to resolve stack-too-deep)*
- [x] **M-8** — Redesign `appeal()` to accept multiple appellants.
      Either party can call; first call creates the Kleros dispute,
      subsequent calls add to a shared bond pool. Bond refund logic
      distributes proportional to contribution. *(commit cf39f5d —
      scope tightened: only the losing party of the provisional
      ruling can appeal, removes front-run vector without a bond
      pool)*
- [x] **Test sketch expansion** — `contracts/test/draft/Kleros.t.sol`
      gets new test stubs for every added path: race window,
      ruling=0, 90-day fallback, pause-while-active, multi-appellant.
      Stubs, not full tests (full tests are Phase 4 work).
      *(commit cf39f5d — 8 pause tests under "PAUSABLE TESTS (M-7)"
      are full tests, not stubs)*

### Acceptance

- Draft compiles with Foundry (not just passes syntax — compiles
  against a stubbed IArbitratorV2).
- Test sketch enumerates ≥12 distinct test cases.
- Every new function has a natspec block explaining who, when, why.
- No TODO in the draft left pointing at a known failure mode.

### Stop condition

If C-2's race-condition fix introduces a new griefing vector
(finalize being delayed indefinitely by adversarial appeal spam),
escalate to founder decision before merging. We'd rather hold than
ship a new bug.

---

## Phase 2 — AI pipeline hardening (this week, ~6h, 🤖)

**Goal:** the arbitration pipeline stops relying on security
properties it doesn't actually have.

### Items

- [x] **C-6** — Replace the 0.7 confidence gate with an **ensemble
      disagreement gate**. Implementation: N independent Claude
      calls (different temperatures, different phrasings of the
      same rubric); escalate to human review if any two calls
      disagree on the majority-vs-minority split by >15bps. Document
      in `src/arbitration/calibration.md`.
      *(commit 26c8ecd — two-gate system: `LOW_CONFIDENCE_GATE=0.60`
      and `SPLIT_CONFIDENCE_GATE=0.75`. Verdict records now carry
      `ensemble_disagreement` and `escalation_reason`. Standalone
      calibration doc deferred to Phase 4 when real verdict data
      exists to calibrate against.)*
- [x] **M-3** — Rewrite prompt-injection defense as **structural
      isolation**, not pattern match. Concretely:
      - Untrusted user text wrapped in `<untrusted_user_input>` tags
        with closing-tag escaping.
      - System prompt explicitly names which tags are trusted.
      - Delete the current string-match list (ineffective theater).
      - Add a 50-case red-team corpus at `tests/red-team/prompts/`.
      - CI fails if any corpus case produces a verdict that
        follows the injected instruction.
      *(commit 26c8ecd — `wrapUntrusted(tag, text)` XML-wraps every
      untrusted field and escapes closing-tag bytes with a zero-width
      space. Both LLM prompts now lead with a SECURITY CONTRACT
      preamble. Unit tests W1-W5 pin breakout-safety. The 50-case
      red-team corpus is deferred to Phase 4 alongside live verdict
      replay.)*
- [x] **M-4** — Amend the arbiter SOP (`docs/arbiter-sop.md`;
      create if missing) to require:
      1. Fetch `verificationURI`.
      2. Compute `keccak256` of fetched bytes.
      3. Compare against on-chain `deliveryHash`.
      4. If mismatch → rule for buyer automatically; do not
         invoke the LLM pipeline.
      Implement step 4 in code, not just docs.
      *(commit 26c8ecd — SOP documented in
      `docs/security-checklist.md` §2.5 with the tamper-evidence gap
      called out honestly. `verifyDeliveryContentHash` recomputes
      sha256 and surfaces `content_hash_match` through the evidence
      bundle; mismatch is a hard escalation gate in
      `arbitrateDispute` (not "auto-rule for buyer" — that would be
      wrong when the bad hash is the stored record, not the content).
      Eleven unit tests in `test/arbiter-content-hash.test.js`.)*
- [ ] **Calibration dashboard (internal)** — Create
      `scripts/arbiter-calibration-report.py` that, given a
      time range, emits: (a) confidence bucket vs. accuracy
      (stratified by dispute type), (b) ensemble-disagreement
      rate, (c) escalation rate to human review.
      *(deferred to Phase 4 — no prod verdict corpus yet)*

### Acceptance

- Red-team corpus runs in CI and passes.
- Every verdict record has: fetched-hash, on-chain-hash, match
  boolean, N model calls with their individual rulings, final
  ruling, confidence-method identifier.
- SOP lives at `docs/arbiter-sop.md` and is referenced from the
  security checklist.

### Stop condition

If building the ensemble disagreement gate reveals that the current
verdict pipeline actually *is* single-call-Claude (not N=3), pause
and return to the M-5 finding — update the public architecture
page before continuing.

---

## Phase 3 — Founder decisions

**STATUS 2026-04-23:** Phase 3 substantially collapsed by the M-0
architecture decision.

The founder reviewed the M-1 brief and, seeing the $60/case Kleros
floor, decided v1 will ship **without** a Kleros appeal layer. See
`docs/decisions/M-0-arbiter-architecture-v1.md`.

### Consequences

- [x] **M-1 — SUPERSEDED.** No Kleros means no bond. Brief marked
      superseded; retained for historical context and Phase 6
      UMA research.
- [ ] **M-2 — OPEN, RESHAPED.** With no Kleros, the question is no
      longer "publish reversal rate?" but "how do we honestly
      grade our own ruling quality?" New brief at
      `docs/decisions/M-2-transparency-posture.md` proposes
      internal audit rate + 10% gate + quarterly aggregate
      report. Awaits founder sign-off.
- [x] **M-6 — SUPERSEDED.** No bond, no currency question.
- [x] **Two-tier design doc** — marked DEPRECATED.
- [x] **Kleros integration plan** — marked DEPRECATED.

### Remaining Phase 3 items

- [x] **M-2 founder sign-off** — resolved 2026-04-23:
      **option (a), per-case public**, overriding recommendation.
      Founder accepts short-term noise and cherry-picking risks
      in exchange for maximum brand-alignment with "everything
      can be verified."
- [x] 🤖 `docs/transparency-policy.md` written, commit TBD.
- [ ] 🤖 Update public site copy (`arbitova.com` homepage and
      `/architecture` and `/learn`) to remove any "decentralized
      appeal" or "Kleros" language. v1 messaging is "AI-first
      arbitration with multisig-signed rulings; every verdict
      public at arbitova.com/verdicts."
- [ ] 🤖 Wire the verdict-browsing dashboard at
      `arbitova.com/verdicts` (list + per-case + JSON endpoints).
      Engineering — Phase 4 territory.
- [ ] 🤖 Add SDK + UI disclosure banner for party consent to
      per-case publication, per the transparency policy.
- [~] 🤖 Add re-audit workflow to ops runbook. **Superseded 2026-04-24:** re-audit program removed in transparency policy v1.1 (staffing gap — Arbitova has one operator; `operator_id ≠ original` is not satisfiable). See dev log #023 and `docs/transparency-policy.md` amendment log. Runbook §1 re-audit workflow removed in the same amendment.

### Stop condition

None of the remaining items block v1 contract deployment. The
site-copy update should ship before any public launch post. The
verdict dashboard should ship before first real dispute on
mainnet (not a hard ship-blocker for Sepolia itself).

---

## Phase 4 — Sepolia Phase 1 deploy (next week, ~3 days, 🤖 + monitoring)

**Goal:** a hardened draft is running on Sepolia, observed for one
week.

### Items

- [ ] **Contract surgical amend** — Merge `EscrowV1WithKleros.sol`
      changes into a new `EscrowV1_1.sol` (or `EscrowV1Appeal.sol`),
      behind a feature branch. Keep `EscrowV1.sol` at current
      Sepolia state for existing flow.
- [ ] **Foundry test suite** — Full test coverage for every test
      sketch added in Phase 1, plus existing 66 tests must still
      pass against the amended contract.
- [ ] **Deploy to Sepolia** — New contract at a new address;
      leave the old `0xA8a031b...` in place for compatibility.
- [ ] **SDK update** — JS + Python SDK 4.0.0-alpha with new
      appeal/finalize methods. Old `resolve()` throws with a clear
      migration message, not a silent revert.
- [ ] **Six synthetic scenarios**, each end-to-end on Sepolia with
      real multisig signatures (D-1 multisig can be 2-of-3 for
      testnet):
      1. Dispute → first-instance → no appeal → finalize clean.
      2. Dispute → first-instance → buyer appeals → Kleros upholds
         → bond forfeit, funds pay per provisional.
      3. Dispute → first-instance → seller appeals → Kleros reverses
         → bond refund, funds pay opposite of provisional.
      4. Kleros returns `ruling=0` → provisional retained, bond
         refunded.
      5. Kleros stalls → 90-day fallback executes → provisional
         retained.
      6. Both parties appeal → shared dispute → Kleros rules → bond
         distributed proportionally.
- [ ] **Indexer zero-drift run** — `services/indexer/` (or
      equivalent) tailing new events for 7 consecutive days;
      byte-for-byte reconciliation against `eth_getLogs`.

### Acceptance

- All six scenarios green with transaction hashes recorded in
  `docs/phase-1-rehearsal-log.md`.
- Indexer zero-drift run completed; drift count = 0.
- SDK 4.0.0-alpha published to npm (alpha tag) and PyPI (pre-release).
- Phase 4 retrospective document lists any issues found and whether
  they blocked subsequent phases.

### Stop condition

- Any scenario fails on Sepolia → stop, fix root cause, re-run all
  scenarios. Do not proceed with partial success.
- Indexer drift > 0 → stop, even if drift looks trivial. "Trivial
  drift" in testnet means catastrophic drift in mainnet.

---

## Phase 5 — Legal + external primer (2–4 weeks, 👤-led)

**Goal:** the items that require people outside engineering.

### Items

- [ ] **C-5 (founder + counsel)** — Engage DeFi counsel (US + any
      additional jurisdictions of relevance) to review:
      - Whether effective control through `setArbiter` +
        `resolve()` + fee configuration constitutes custody under
        current FinCEN / SEC interpretation.
      - Whether the two-tier design changes the analysis.
      - Recommended positioning language. Do not self-certify
        "non-custodial" without counsel opinion on record.
      Budget: $3k–$10k for an initial memo.
- [ ] **D-2 (🤖 drafts, 👤 reviews)** — Write
      `docs/kleros-jury-primer.md`. Plain-English explainer of
      agent-to-agent commerce, what the evidence bundle contains,
      how to read a `verificationURI`, what honest judgment looks
      like for this class of dispute. Target audience: a juror
      who has never heard of AI agents.
- [ ] **Bug bounty design** — Spec a funded bounty program (amount,
      scope, rules). Doesn't have to launch yet; just needs to be
      designed and budgeted so the mainnet gate is actually
      achievable.

### Acceptance

- Written legal memo on file (confidential; not committed).
- Jury primer committed to repo; linked from architecture page.
- Bug-bounty design committed to `docs/bug-bounty-design.md`.

### Stop condition

If counsel advises that the current architecture cannot be called
non-custodial in any material jurisdiction, this forces a product
pivot, not a wording change. Escalate before proceeding.

---

## Phase 6 — External audit + fuzz (before mainnet, 4–8 weeks, 👤-led)

**Goal:** the pre-mainnet gates from `architecture.html` / `security-
checklist.md` §8 are actually green, not aspirational.

### Items

- [ ] **Third-party audit** — Engage at least one reputable shop
      (Trail of Bits, OpenZeppelin, Spearbit, Code4rena). Scope:
      the amended `EscrowV1_1.sol` + Kleros integration + any new
      imports. Budget: $25k–$80k depending on firm and turnaround.
- [ ] **Fuzz suite** — `forge test --fuzz-runs 1000000` across all
      state transitions. Target: no reverts outside of documented
      invariants.
- [ ] **Multisig deploy + rehearsal** — Full 3-of-5 Safe stood up
      on Base mainnet; signer SOP rehearsed end-to-end; rotation
      drill completed.
- [ ] **Kleros mainnet integration** — Live Kleros arbitrator,
      real jury pool, at least 10 real testnet cases run to
      completion before mainnet deploy.
- [ ] **Incident response playbook** — Written, not just
      intended. Who gets paged when. Who can pause. Who can call
      emergency fallback. Who talks to users when something is on
      fire.
- [ ] **Public security contact** — `security@arbitova.com` or PGP
      pubkey published on website. Tested by sending at least one
      real vulnerability report to it.

### Acceptance

- Audit report: 0 critical, 0 high findings unresolved.
- Fuzz suite: ≥1M runs, no failures.
- Multisig: 2 successful rotation drills + 1 emergency-fallback
  rehearsal.
- Kleros: 10 real Kleros Sepolia verdicts in the bag.
- Security contact: received and triaged at least 1 message.

### Stop condition

Any unresolved high or critical audit finding → do not deploy to
mainnet. "We'll fix it post-launch" is not acceptable.

---

## Phase 7 — Mainnet deploy (gated by all prior phases)

**Goal:** the thing actually ships, with eyes open.

### Items

- [ ] Final checklist review against `security-checklist.md` §8.
- [ ] Mainnet deploy transaction; record block number, gas used,
      verified on Basescan mainnet.
- [ ] Canary period: one week of active monitoring, $X cap on total
      value locked (suggest $50k initial cap).
- [ ] First real mainnet dispute run end-to-end.
- [ ] Public launch post + dev log.

### Acceptance

- Deployed and verified on Base mainnet.
- At least one real dispute resolved cleanly.
- Monitoring dashboards green for 7 consecutive days.

### Stop condition

Any anomaly in canary period → pause new escrow creation via the
new `Pausable` mechanism and investigate before allowing further
volume.

---

## Cross-cutting policies

### Decision changelog

Every time this plan changes, a line goes into
`docs/decisions/remediation-changelog.md`. Format:
`YYYY-MM-DD: <change> — <why>`. No silent edits.

### Weekly checkpoint

Every Friday (or equivalent), the founder and assistant review:
- Which phases have moved forward this week.
- Which items were discovered to be harder than estimated.
- Whether any stop condition has been hit.
- Whether the plan still reflects reality.

If Friday's review finds ≥2 estimates were off by ≥2x, the plan
is re-baselined, not adjusted around. Optimistic estimates
compound.

### What this plan deliberately does NOT do

- Doesn't block on marketing milestones (Show HN, framework PRs,
  etc.). Those can run in parallel during Phases 0–3.
- Doesn't promise specific dates. Estimates are in hours of focused
  work, not calendar time.
- Doesn't reorder phases for convenience. Gates are gates.

---

## Current status (2026-04-23)

- Phase 0: not started.
- Phase 1: not started (draft contract exists but isn't yet hardened).
- Phase 2: partial (red-team corpus doesn't exist; content-hash
  verification not in code).
- Phase 3: blocked on founder decisions.
- Phase 4–7: blocked on 0–3.
- ✅ ADMIN_KEY rotation (D-4): done 2026-04-23.
