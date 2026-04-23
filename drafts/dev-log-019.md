---
slug: dev-log-019-positioning-as-protocol
title: "Dev Log #019 — Positioning as Protocol"
category: product
excerpt: "I was positioning Arbitova as a product. Every line on the homepage said 'we built X.' But the thing on-chain is not a product — it's a protocol. The contract doesn't care who talks to it. Here's what I changed on the site to stop getting in my own way."
cover_image: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

A week of outside eyes said the same thing three different ways: "I can't tell what Arbitova is — SaaS, wallet, or contract?" The answer is a contract. The fact that we also ship SDKs and a webapp doesn't change that. I rewrote the hero, the trust row, and added a public roadmap so the protocol-vs-product distinction is visible in the first five seconds.

This log is about the positioning change, not the code. No new functionality ships here.

## The line I was using

> *Escrow and arbitration for AI agents. Plug into any A2A framework.*

It reads like a SaaS tagline. It implies there's a service called "Arbitova" that you plug things into. It's not wrong exactly — the SDK does plug into any framework — but the actual thing you're trusting is an `EscrowV1` contract on Base Sepolia. The tagline hides that.

Worse: "Plug into any A2A framework" is an integration claim dressed as a value claim. What I actually do is hold your USDC non-custodially and route disputes. Whether you integrate via the SDK, raw ethers calls, or your own frontend is your problem.

## The line now

> *An open escrow protocol for the agent economy.*

Three deliberate choices:

- **"Open protocol"** — forkable, permission-less, no admin key that can sweep funds. The current contract matches this; nothing else on the site should contradict it.
- **"For the agent economy"** — larger than our repo. This frames Arbitova as infrastructure for a market that exists (x402, Coinbase CDP, MCP) rather than a standalone app someone has to believe in.
- **Dropped the integration claim.** Integration belongs below the fold, inside the `/integrate` page where I can actually show three paths side-by-side.

## What else changed

**Subtitle** now leads with "non-custodial" and names three integration paths:

> *Non-custodial USDC escrow for AI agents. Built as a protocol, not a product — the contract holds the funds, an arbiter routes disputes without unilateral sweep, and every verdict is public. Integrate directly, use a reference SDK, or run your own frontend.*

The phrase I care about here is **"without unilateral sweep."** An earlier draft said "no arbiter can touch the money" which is false — the arbiter splits funds on `resolve`. What's true is that the arbiter can't pull funds to themselves. The contract enforces that on-chain. "Unilateral sweep" is the precise word for the power the arbiter doesn't have.

**Trust row** dropped aspirational items, kept provable ones:

- Live on Base Sepolia — chain 84532
- Contract verified on Basescan — no admin sweep
- Three SDKs: Python, JavaScript, MCP

The "Funds never leave your wallet until you lock escrow" line was technically true but vibed like marketing. "No admin sweep" is the same claim in the language the audience uses.

**New Roadmap section.** Items currently drifting between "in progress" and "someday" needed a labelled home. x402 adapter, CDP wallet integration, Kleros arbitration, reputation NFTs, multi-chain — all tagged as "In progress" or "Planned" so readers can tell shipped from planned at a glance. This is also why I moved the x402 claim off the hero: it's not shipped yet, it goes in the roadmap.

## What didn't change

The contract, SDKs, MCP server, `/pay/` UI, and `/verdicts` are untouched. Positioning was the bottleneck, not the product.

## What I got wrong last time (and am publishing anyway)

One of the PR drafts I wrote for the `awesome-x402` listing claimed Arbitova runs "N=3 independent AI verifiers with tiebreaker logic." It doesn't. It runs a single arbiter whose verdict is generated with a confidence gate — if the model's confidence is below 0.7, the dispute escalates to human review before the arbiter signs. Multi-verifier N=3 is on the roadmap (alongside Kleros), not shipped.

The PR never left my machine. I caught it during a self-review of positioning claims. I rewrote the PR body to describe the single-arbiter-with-confidence-gate that's actually running, and renamed the old draft to `AWESOME_X402_PR_OLD.md` so I can't accidentally submit the inaccurate one.

Publishing this here because the pattern matters: when you're shipping in public, your future drafts will lie on your behalf if you don't re-read them against the live system.

## Next

- `/integrate` page goes up today with three concrete paths (raw contract / SDK / CDP agent-native).
- x402 adapter design doc goes into `docs/` this week — real spec, not marketing copy.
- Multisig arbiter (3-of-5 Safe) is the next concrete reduction in single-arbiter trust. Kleros integration is planned but gated on Kleros v2 mainnet readiness.

If any of the wording above sounds wrong, open an issue on `jiayuanliang0716-max/a2a-system`. Honest edits are the whole point.
