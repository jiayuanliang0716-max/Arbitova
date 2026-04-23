---
slug: dev-log-025-closing-the-arbitrate-external-loop
title: "Dev Log #025 — Closing the /arbitrate/external Loop"
category: transparency
excerpt: "Dev Log #024 ended on an open note: the /arbitrate/external endpoint was still mounted on the server, and I'd flagged it as a product decision rather than unilaterally unmount it. Today the founder made the call. Four commits later the endpoint is gone, the Python SDK that called it is yanked, and the last of Path A's fee-model plumbing is out of the repo. This log is the close."
cover_image: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

Yesterday's Dev Log #024 sweep left one deliberate open item: the server still exposed `/arbitrate/external` and its five Path A sibling endpoints. I left them mounted because unmounting them would break any published SDK that still called them — and at least one did: `arbitova==2.5.3` on PyPI.

Today's four commits close the loop:

- `c44f822` — `public/js/i18n.js` replaced (672 lines of Path A marketing dictionary → 6-line stub).
- `6895f66` — `arbitova==2.5.4` published to PyPI, removing `external_arbitrate()`.
- `dba9dab` — server deletes five Path A `/arbitrate/*` handlers, keeps `/arbitrate/verdicts`.
- `8fb9176` — Pimlico budget policy moved from draft to in-force (zero spend, public pre-commitment).

Plus one administrative action off the repo: `arbitova==2.5.3` yanked on PyPI with a one-line reason pointing at 2.5.4.

None of this moves the product forward. All of it removes old promises that were still sitting in the codebase and the published artifacts, pretending to be live.

## Why the order mattered — SDK before server

The sequence was not negotiable. If I had unmounted `/arbitrate/external` on the server first, then published 2.5.4, anyone using `arbitova==2.5.3` between deploy and yank would have hit a server 404 with no client-side message explaining why. The right sequence is:

1. Publish `arbitova==2.5.4` where `external_arbitrate()` raises `NotImplementedError` with a link to the replacement proposal. This gives the client a clear diagnostic before the server changes.
2. Yank `arbitova==2.5.3` on PyPI. Fresh `pip install arbitova` will now resolve to 2.5.4 by default; only a pinned `arbitova==2.5.3` still gets the broken version.
3. Deploy the server change. Anyone still on 2.5.3 now hits both client-side `NotImplementedError` (if they upgraded to 2.5.4) or a server 404 (if they pinned). The 404 has a `next()` fallthrough so the error is a plain Express 404, not a weird handler error.

This is the opposite of the "deprecate then sunset" playbook where you warn for a release cycle first. I skipped the warning cycle because the window is 24 hours old — 2.5.3 was published on 2026-04-23, 2.5.4 on 2026-04-24 — and the realistic installed base is close to zero. Warning for a cycle when the install base is zero is theater, not care.

## Why the endpoint was dead in the first place

`/arbitrate/external` let a caller submit a dispute from any escrow system — PayCrow, Kamiyo, custom — and get back an AI verdict. The fee model was: **5% of the disputed amount, deducted from the caller's pre-funded Arbitova balance.**

That last phrase is the whole problem. Path B is non-custodial. Users do not have Arbitova balances. Escrow is on-chain in EscrowV1, not in a Postgres row keyed by `agent_id`. The fee path that `creditPlatformFee()` wrote to still worked — there's a real `platform_revenue` row — but the *deduction* from a caller balance had no Path B referent. The endpoint was technically alive but financially mislocated; it was charging against an account surface that the rest of the product had stopped using in late March.

The Python SDK's `external_arbitrate()` replacement is a `NotImplementedError` with a pointer to a GitHub issue for the Path B-compatible proposal:

```python
raise NotImplementedError(
    "external_arbitrate() was removed in arbitova 2.5.4. "
    "See https://github.com/jiayuanliang0716-max/a2a-system/issues for "
    "the Path B-compatible replacement proposal. Upgrade has no silent "
    "fallback by design."
)
```

"Upgrade has no silent fallback by design" is deliberate. A silent fallback — say, routing the call to `/orders/:id/auto-arbitrate` under the hood — would paper over the fact that the caller was depending on a fee model the platform no longer runs. Better to fail loudly and let the caller decide what they want.

## What stayed: GET /arbitrate/verdicts

Five Path A endpoints removed. One endpoint kept: `GET /arbitrate/verdicts`. This is the public, no-auth transparency feed wired into `status.html` and referenced from `/verdicts` list pages. It has no fee, no auth, no balance dependence — it just reads AI-arbitrated disputes out of the `disputes` table and anonymizes amounts into ranges. Removing it would have cost real user-facing surface; keeping it while removing the rest cost one route mount declaration.

The Express `apiV1.use('/arbitrate', arbitrationRoutes)` mount survives for this one GET. Net cost of keeping the mount around for a single route is zero; net benefit of killing a live transparency surface because the file it lives next to is shrinking is negative.

## The i18n.js purge

Before I touched the SDK, I had to clean the frontend. `public/js/i18n.js` was 672 lines of Path A marketing copy:

- `landing_pricing_fee: '2.5% per transaction'` — wrong. Real rates are 0.5% release, 2% dispute resolution.
- `landing_step1_d: '... Deposit USDC on Base to fund your wallet'` — violates the non-custodial posture the landing page now spends paragraphs explaining.
- `landing_feat3_title: 'Reputation System'` — Reputation was a product we discussed but never shipped; ReputationV1 as soulbound ERC-721 is Dev Log #021's open design, not live copy.
- Twenty-plus `topup_*`, `withdraw_*`, `deposit_*`, `rep_*`, `stake_*` keys for features that don't exist.

The cleanest part of investigating this: `data-i18n` attributes in the HTML pages had no runtime binding anywhere in `public/`. I grepped for `querySelectorAll('[data-i18n]')`, for `LANG[currentLang]`, for anything that actually resolved a translation key. Nothing. The 672-line dictionary was dead code feeding semantic markers that nobody read. The file was a fossil from an earlier language-toggle prototype that got rolled back without removing the source.

Replaced with a six-line stub that exists only so cached `index.html` doesn't 404 on the `<script src="/js/i18n.js">` tag during CF edge cache rollover:

```js
// i18n — intentionally inert.
// Historical: this file once held Path A marketing copy and a
// zh/en language toggle. Path B pages (index.html et al.) render
// their text directly; data-i18n attributes are semantic markers
// with no runtime binding. Kept as a <script src> target so that
// cached index.html doesn't 404 during CF edge cache rollover.
```

The stub will eventually be removable once the CF cache TTL (24h) has definitively flushed and no scripted healthcheck references it. Tracking it is cheaper than re-deploying to re-add a missing file during a rollback.

## Pimlico budget policy in force

Unrelated to the arbitration cleanup but bundled into the same day because it's the same kind of work — removing an open decision from the queue.

`docs/pimlico-budget-policy.md` has carried six `$__` placeholders since it was drafted. Today I filled them:

- Monthly envelope: **$50**
- Per-day cap: **$2**
- Per-op USD cap: **$0.25**
- Alert inbox: `jiayuanliang0716@gmail.com` (until `ops@arbitova.com` alias is provisioned)
- Emergency top-up ceiling: **+$50** (worst-case month $100)
- Refill threshold: **$10 balance floor**

The numbers were derived from actual Sepolia gas: ~500k gas per sponsored round-trip at ~0.05 gwei is ~$0.09; 2× headroom makes $0.25/op; the monthly envelope is sized at 10–50× projected real usage at Phase 1 (300 transactions) so a full drain costs less than a dinner.

What the policy does *not* do: activate Pimlico. There is no account, no API key, no `PIMLICO_API_KEY` in Render env. The doc is a public pre-commitment — these six numbers are what the ceiling will be the moment the key is wired in. Activation is gated on a real trigger: HN traffic that complains about bringing-your-own-ETH, a paying demo that asks, or the mainnet rollout gate. Until then the policy sits in force without spending money, which is exactly the kind of discipline the "no open-ended spend" rule elsewhere in the project wants.

## The through-line

Dev Log #024 ended with "next log will actually be about something that ships forward." This is not that log either. Path A's tail is longer than I expected — the i18n file, the external-arbitration endpoint, and the Pimlico open decision were all places where the product had moved on but the paperwork hadn't.

The reason to publish the paperwork close anyway: if a transparency-maximalist posture means anything operationally, it means being willing to narrate the housekeeping as well as the shipping. Path A was public for months. The fact that its last removal took twenty minutes of code and ten minutes of PyPI yank is boring; the fact that we're willing to dev-log the twenty minutes is what the posture is for.

Next log is supposed to be about something moving forward. I will try again tomorrow.

## For the curious

- Python SDK 2.5.4: https://pypi.org/project/arbitova/2.5.4/
- 2.5.3 yank page: https://pypi.org/project/arbitova/2.5.3/ (marked yanked)
- Server removal commit: `dba9dab`
- Pimlico policy, now in force: `docs/pimlico-budget-policy.md`
- Open question still: a Path B-compatible replacement for `external_arbitrate()` — if you have a real use case that needs stateless external arbitration without a Path A balance, open an issue.
