# Arbiter operations runbook

Status: **v0.1 — adopted 2026-04-23**
Scope: the internal SOPs that operationalize commitments made in
`docs/transparency-policy.md`. Other ops SOPs (key rotation,
incident response, mainnet deploy) will accrete into this file as
they are written.

## 1. Re-audit workflow

The transparency policy commits us to a 10% sample re-audit with a
confidence-weighted selection and a rolling-30 disagreement gate at
10%. This section is how that commitment is executed without
regressing into "we'll get to it."

### 1.1 Cadence

**Nightly batch at 03:00 UTC.** A scheduled job enumerates the
previous 24 hours of issued verdicts, draws the sample, and
writes the sample set to the `reaudit_queue` table.

Why nightly and not per-verdict: per-case sampling would block the
arbitration pipeline or run concurrently with it, neither of which
adds quality; batching once per day means reviewers handle a small
consolidated queue and the sampler can apply confidence-weighting
across the full day's distribution, not one verdict at a time.

Why 03:00 UTC specifically: the arbitration pipeline's peak is
evening US hours; running the sampler after midnight UTC captures
all of that day's verdicts with some buffer before the next
business day starts for ops.

### 1.2 Sampling mechanism

`scripts/arbitration-reaudit-sample.js` (to be written against the
verdict table schema) performs:

1. Select all verdicts with `issued_at` in the prior 24h.
2. Assign each verdict a sample weight:
   - Default weight: `1.0`
   - If final confidence in `[0.60, 0.75)`: weight `2.0`
3. Target sample size = `round(0.10 * count_of_verdicts)`, with a
   floor of 1 if any verdicts were issued.
4. Draw without replacement, probability proportional to weight.
5. Insert chosen verdict IDs into `reaudit_queue` with status
   `PENDING` and the nightly batch ID.

Sampling is **logged in full** — the rejected candidates and the
RNG seed are stored alongside the chosen sample, so the selection
can be replayed for audit. This is not merely "showing our work";
it's the only way a critic can tell whether we gamed a selection.

### 1.3 Reviewer assignment

Rules (checked by the reviewer-assignment step in the nightly job):

- Reviewer `operator_id` must not equal the original verdict's
  `operator_id`. For AI-only verdicts this is trivially satisfied;
  for human-escalated verdicts it matters.
- Reviewer must not be the on-call incident responder for the
  same day (avoids cognitive conflict with fire-fighting).
- Target state at 500 rulings: contracted external reviewer on
  rotation. Until then, Arbitova ops team rotates.

### 1.4 Review packet

The reviewer receives:

1. The original evidence bundle the AI had (delivery URI,
   verification URI, buyer reason, `content_hash_match` status,
   recorded/recomputed hashes).
2. The AI's ensemble vote breakdown.
3. The final verdict and reasoning text that was signed on-chain.

**Not blind.** This is calibration, not blind consensus. The
question the reviewer answers is "does the reasoning hold up?",
not "would I have reached the same verdict from scratch?". Blind
review doubles reviewer load and produces noise about split
granularity that is rarely actionable. Explicit design choice,
open to reversal if the noise hypothesis turns out wrong.

### 1.5 Disagreement definition

A re-audit disagrees with the original verdict if any of:

- **Winner mismatch.** Re-audit would have awarded to the other
  party, or re-audit would have split where the original did not,
  or vice versa.
- **Split delta >20 percentage points.** If both agreed on
  "split" but re-audit's recommended split is more than 20pp away
  from the on-chain split (e.g., original 70/30, re-audit would
  have been 40/60).
- **Reasoning-level error.** Re-audit flags that the reasoning
  cites a fact not in the evidence bundle, contradicts the
  evidence, or applies a rule not in the arbiter prompt. Winner
  match is insufficient if the reasoning was wrong.

Anything else — within-20pp split differences, tonal disagreement
about certainty — is recorded in the `notes` field but does not
count toward the gate.

### 1.6 Data model

New Postgres table `arbitration_reaudits`:

```
id                        uuid PK
verdict_id                uuid FK → arbitration_verdicts.id
audit_batch_id            text (YYYY-MM-DD of the nightly batch)
auditor_operator_id       text
reviewed_at               timestamptz
agree_winner              bool
agree_split_within_20pp   bool (nullable if not a split)
reasoning_holds_up        bool
disagrees                 bool (computed: any-of the above false)
recommended_split_bps     { buyer_bps, seller_bps } (nullable)
reasoning_text            text
notes                     text
```

Publication surface `/verdicts/{disputeId}` reads from this table
for the "Re-audit status" section.

### 1.7 Rolling-30 gate monitor

`scripts/arbitration-reaudit-rolling.js` runs nightly after the
day's re-audits are filed. It:

1. Pulls the most recent 30 completed re-audits (ordered by
   `reviewed_at`).
2. Counts `disagrees = true`.
3. If count/30 > 0.10, writes a row to `reaudit_alerts` with
   severity `GATE_BREACH` and the batch window.

A gate breach fires a notification to the founder + ops lead. The
policy commitment is: **within 30 days of the breach, a public
root-cause dev log is published** explaining what the re-audits
caught and what changes ship to the arbitration pipeline.

The 30-day clock starts at the `reaudit_alerts.created_at` of the
first breach, not at the date anyone noticed. This is a hard
commit in the policy document and is not relaxable without a
visible edit there.

### 1.8 Publication to `/verdicts/{disputeId}`

Per-case page logic:

- If `reaudit_queue` has no row for this verdict → display "Not
  selected for re-audit in the 10% sample cycle."
- If `reaudit_queue` row exists but `arbitration_reaudits` row
  does not yet → display "Re-audit pending (selected {date})."
- If `arbitration_reaudits` row exists → display the full row
  rendered as structured content alongside the original verdict,
  with the disagreement flag and reasoning visible side-by-side.

Re-audits are never used to quietly edit the original verdict.
The on-chain verdict is immutable; re-audit is additional data.

### 1.9 What is still to build (before Phase 4)

- `scripts/arbitration-reaudit-sample.js` (nightly sampler).
- `scripts/arbitration-reaudit-rolling.js` (nightly gate monitor).
- `arbitration_reaudits` table migration.
- `/verdicts/{disputeId}` dashboard route with the re-audit
  section wired up.
- Reviewer CLI or lightweight web form that writes into
  `arbitration_reaudits`.
- Pager/email hook on `reaudit_alerts.GATE_BREACH`.

These are tracked as Phase 4 engineering work. The commitment is
in policy; the tooling turns the commitment into a repeatable
operation. Until Phase 4 ships, the runbook serves as a design
doc and the re-audit process runs manually with a reviewer CLI
stub.

---

## 2. (reserved) Key rotation

Outline only; detailed SOP accretes here once the 3-of-5 Safe is
live and we've rehearsed a rotation on Sepolia. For now see
`docs/multisig-arbiter-design.md` §"Migration plan (testnet)".

## 3. (reserved) Incident response

Outline only; to be written after the first Phase 4 Sepolia
incident exercise. Contract-level escape hatch is `Pausable`
(maintained in `contracts/src/EscrowV1.sol`), covered by the
security checklist.
