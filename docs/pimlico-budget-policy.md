# Pimlico Monthly Budget Policy (v0.1)

Status: **in force** (numbers set 2026-04-24) · Pimlico account not yet
provisioned · this policy becomes active the moment the API key is
wired into Render env. Until then the numbers stand as a public
pre-commitment.

Depends on: `docs/pimlico-paymaster-plan.md` (integration plan).
Related: `packages/paymaster-policy/src/index.js` (the pure-logic sponsorship
decision — enforces the per-op gas ceiling + daily budget read from this
document).

Why this document exists: Pimlico sponsorship is a recurring spend with a
sharp blast radius. Without a pre-committed budget policy, there is no
written answer to *"what happens when the paymaster hits its cap?"* and no
one is accountable for refill decisions. This file is that answer.

---

## 1. Scope

This policy governs Arbitova's **Base Sepolia testnet** Pimlico project.
Mainnet is **out of scope** for v0.1 and gated on:

- Mainnet audit pass
- Multisig arbiter live
- Separate Pimlico project with its own budget policy (re-derived with
  mainnet gas pricing, not a copy-paste of this file)

Non-goals for this policy:

- Sponsoring non-Arbitova contracts — denied structurally by
  `packages/paymaster-policy`, not by budget.
- Sponsoring arbiter `resolve()` calls — arbiter pays its own gas
  (`docs/pimlico-paymaster-plan.md` open question 2, resolved).

---

## 2. Inputs that set the budget

Pull these numbers before picking envelope sizes:

| Input | Source | Current value |
|---|---|---|
| Sepolia gas price (median) | Basescan / Alchemy | `__ gwei` |
| `createEscrow` gas used | Sepolia trace | `~250k` |
| `confirmDelivery` gas used | Sepolia trace | `~150–200k` |
| `escalateIfExpired` gas used | Sepolia trace | `~500k` |
| `approve` (USDC) gas used | Sepolia trace | `~50k` |
| Full sponsored round-trip gas | Sum of above | `~500k` |
| Current sponsored ops / week | Pimlico dashboard | `__` |
| Projected ops / week (next 30d) | Product forecast | `__` |

These inputs feed the envelope math in §3.

---

## 3. Monthly envelope

Arbitova commits to a rolling **$50 / month** Pimlico sponsorship envelope
for Base Sepolia. This envelope is:

- **Set by**: founder, documented in this file.
- **Reviewed**: first Monday of each month (see §8).
- **Source of funds**: Pimlico prepaid credit balance (not credit card
  auto-charge — see §7).

Derived ceilings:

| Ceiling | Formula | Value |
|---|---|---|
| Per-month cap | Envelope | **$50** |
| Per-day cap | Envelope ÷ 30 × 0.8 (weekend-spike absorber), rounded | **$2/day** |
| Per-op gas cap | `docs/pimlico-paymaster-plan.md` §v0.1 | `600k gas` |
| Per-op USD cap | Per-op gas × Sepolia ~0.05 gwei × ETH ~$3500 × 2× headroom, rounded | **$0.25/op** |

The per-day and per-op USD caps are fed into
`packages/paymaster-policy` as `dailyBudgetWei` and `perOpGasCeilingWei`
via env vars. Changes to these numbers ship with a commit to the paymaster
config, not silently.

---

## 4. Burn-rate monitors and alert thresholds

The Pimlico dashboard exposes per-day and per-month consumption. We
alert on:

| Threshold | Action | Who |
|---|---|---|
| 50% of monthly envelope consumed before day 15 | Investigate — is traffic real or abuse? | Founder |
| 80% of monthly envelope consumed | Pre-commit decision: top up or tighten policy (§6) | Founder |
| 100% of monthly envelope consumed | Paymaster auto-denies new sponsorship (policy returns `sponsor: false, reason: "daily budget exceeded"`). Users can still transact with their own ETH. | Automatic |
| Per-day cap hit before 18:00 UTC | Pause sponsorship for the rest of the day; investigate before next day | Founder |

Monitoring wiring: Pimlico dashboard email alerts at the 50/80/100% marks,
pointed at the founder inbox (`jiayuanliang0716@gmail.com` until an
`ops@arbitova.com` alias is provisioned; swap at that point). If email
alerts prove unreliable, we poll the Pimlico API from the existing daily
reconcile cron (see `project_arbitova_fee_pipeline` memory) and raise on
the same threshold.

---

## 5. Overrun policy — what happens at 100%

When the monthly envelope is consumed:

1. **No emergency top-up by default.** The cap exists to force a
   conversation, not to be bypassed. If traffic is real, §6 applies. If
   traffic is abuse, the right response is a policy tightening, not more
   budget.
2. **User-visible behavior**: new sponsored UserOps fail with a Pimlico
   error. Clients should fall back to "bring your own ETH" mode
   (documented at `/docs` for end users, handled automatically by the
   SDK's paymaster helper — it throws and the caller catches).
3. **Public disclosure**: if the cap is hit and the paymaster is
   effectively off for the remainder of the month, we post a one-line
   status note on the site (same surface as other incident notes).
   Consistent with transparency posture — we don't quietly fail users.
4. **Post-mortem**: a dev log post within 30 days covering the cause,
   whether policy limits held, and whether the envelope needs to change.

---

## 6. Refill / envelope-change decision authority

Any of the following require founder sign-off in writing (commit
message, dev log entry, or `docs/pimlico-budget-policy.md` amendment):

- Raising the monthly envelope above its current placeholder value.
- Lowering the per-op or per-day caps below what's in §3.
- Adding a new allowed target contract (a policy change, not a budget
  change — document it in `packages/paymaster-policy` commit too).
- Topping up mid-month above the current month's envelope.

Emergency refill during a live incident (e.g. legitimate traffic spike
during a Show HN thread): founder can authorize a one-time top-up up to
**$50** above the envelope without amending this document, but must
dev-log it within 7 days. This bounds the worst-case month at **$100
total** (envelope + one emergency). Anything beyond that requires a
policy amendment, not an operational decision.

---

## 7. Prepaid credit model

We hold a prepaid Pimlico balance rather than auto-charging a credit
card. Reasons:

- **Hard cap.** A drained prepaid balance cannot be overdrawn. A credit
  card on auto-refill can be.
- **Observable.** The balance number is the blast radius; no need to
  reconcile a monthly invoice.
- **Separable from other spend.** Arbitova's stripe/LemonSqueezy/etc.
  billing surfaces stay separate from sponsorship spend.

Top-up cadence: when Pimlico balance drops below **$10**, top up to
the next full month's envelope. $10 at the $2/day cap = 5 days of
runway — enough to notice and refill, small enough that float stays
tight.

---

## 8. Review cadence

First Monday of each month, the founder reviews:

1. Last month's actual spend vs envelope.
2. Top 5 sponsored operations by gas cost (hunt for policy misses).
3. Any alerts fired in the past month and what action was taken.
4. Whether the envelope for next month should change.

Review output: one short note in `drafts/pimlico-review-YYYY-MM.md` or
inline in a dev log. Not a long document. The point is the act of
reviewing on cadence, not the ceremony.

---

## 9. Abuse scenarios and the controls against them

| Scenario | Control |
|---|---|
| Attacker generates nonsense UserOps to drain budget | `packages/paymaster-policy` rejects non-escrow/non-USDC targets, rejects non-allow-list selectors. Never reaches a billable Pimlico call. |
| Attacker loops `approve(0)` → `approve(amount)` to burn gas | Per-op gas ceiling (§3). Also per-day cap (§4) as last line. |
| Attacker creates very-small-amount escrows just to pay gas | Budget-wise fine (per-op cap holds); product-wise handled by minimum-amount checks in SDK. |
| Pimlico itself goes down | Paymaster returns error; clients fall back to user-paid gas. Documented as expected behavior, not an incident. |
| We misconfigure the Pimlico policy to allow broader targets | Per-day cap (§4) is last-line defense. Alert at 50%/80% gives hours to notice before the cap. |

The nesting is: structural denial (policy code) → per-op cap (Pimlico
setting) → per-day cap (Pimlico setting) → per-month cap (this
document). Four layers; each catches errors the layer above missed.

---

## 10. Founder-set numbers (resolved 2026-04-24)

All six placeholders resolved. The policy is now in force as a public
pre-commitment; it becomes operationally active the moment the Pimlico
API key is wired into Render env.

- [x] §3 monthly envelope — **$50 / month**
- [x] §3 per-day cap — **$2 / day** (= $50 ÷ 30 × 0.8, rounded up)
- [x] §3 per-op USD cap — **$0.25 / op** (500k gas × 0.05 gwei × $3500
      ETH × 2× headroom, rounded)
- [x] §4 alert inbox — `jiayuanliang0716@gmail.com` until
      `ops@arbitova.com` alias is provisioned
- [x] §6 emergency top-up ceiling — **+$50** (caps worst-case month at
      **$100 total**)
- [x] §7 top-up threshold — **$10 balance floor** (≈ 5 days runway at
      the $2/day cap)

Rationale: at Phase 1 (target 300 tx), actual Sepolia gas spend is
$1–5/month. The $50 envelope gives 10–50× headroom and stays small
enough that a full drain is tolerable. The $0.25/op cap bounds
single-op abuse blast radius. The $100 worst-case month matches the
"no open-ended spend" discipline elsewhere in the project.

Activation checklist (do these in order when the first real-user signal
arrives — HN traffic, paying demo, or mainnet gate):

1. Sign up at pimlico.io (Gmail SSO)
2. Create a Base Sepolia project
3. Set per-op USD cap = $0.25 and per-day cap = $2 in the Pimlico UI
4. Fund prepaid balance with $50
5. Generate API key → set `PIMLICO_API_KEY` in Render env
6. Smoke-test a sponsored `createEscrow`
7. Set email alerts at 50/80/100% to the inbox above

---

## 11. Amendment process

Changes to this policy require:

1. A commit to `docs/pimlico-budget-policy.md`.
2. If the monthly envelope changes by more than 20% in either direction,
   a short dev log entry explaining why.
3. Corresponding change to the paymaster config env vars if §3 ceilings
   change.

Matches the "any change must be dev-logged" spirit of the transparency
policy, scaled down to a spend policy's level of public-facing weight.
