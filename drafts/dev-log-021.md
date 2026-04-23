---
slug: dev-log-021-reputation-receipts-and-the-soulbound-question
title: "Dev Log #021 — Reputation Receipts and the Soulbound Question"
category: product
excerpt: "If agents are going to pay each other, they're going to need to know who's good for it. I'm drafting ReputationV1 as a soulbound ERC-721 that records completed escrows. Here's why soulbound and not transferable, and why I'm not writing the score."
cover_image: "https://images.unsplash.com/photo-1521791136064-7986c2920216?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

Agents paying each other need a way to tell good actors from bad ones. Reputation is the usual answer. Reputation that can be bought is not reputation. Reputation that's interpreted centrally is not decentralized. My first pass at this is `ReputationV1` — a soulbound ERC-721 that mints one receipt per completed escrow, and intentionally does not compute a score. The score lives where weights can evolve: off-chain, with whoever's reading the graph.

This log is about the design choice, not the ship date. `ReputationV1` is a draft at `contracts/src/ReputationV1.sol`. No testnet deployment yet.

## What the contract does

Every time an escrow reaches a terminal state that involves a completed payment — `RELEASED` or `RESOLVED` — `EscrowV1` calls into `ReputationV1.mint` twice: once for each party, with a role tag.

```
RELEASED  → BUYER_OK, SELLER_OK           (happy path both ways)
RESOLVED  → BUYER_WON / BUYER_LOST         (based on arbiter split)
           + SELLER_WON / SELLER_LOST
CANCELLED → mints nothing                 (nobody completed)
```

Each token stores the escrow id, the counterparty, the amount, the role, the mint timestamp, and — for `RESOLVED` — the verdict hash. Attributes come back in the `tokenURI` as a data URI JSON blob, so indexers don't have to hit an external host.

Nothing else. No total score, no "arbitova reputation rank," no weighted multi-factor ERC-20. The score is a derivative anyone can compute on top of the receipts.

## Why soulbound

The obvious alternative is transferable ERC-721. An agent with a good track record could sell its reputation NFT collection to another operator. This breaks the entire signal: once reputation is fungible, it's a commodity, and "reputation" becomes "has enough money to buy reputation."

Soulbound means:

- Transfers revert. `approve` reverts. `setApprovalForAll` reverts. The tokens are bound to the address that earned them.
- Burn also reverts. Earned reputation can't be hidden by torching the receipt before a lookup.
- The only state-change path is mint-from-EscrowV1.

OpenZeppelin v5 centralizes ERC-721 transfer logic in `_update`; blocking transfers is one override. The full implementation is under 200 lines.

## Why no score

I went back and forth on this. The case for shipping a score — "arbitova reputation = 847" — is that it's the number dashboards want. The case against is weight drift.

Suppose v1 weights:
- `BUYER_OK`: +1
- `SELLER_OK`: +2
- `SELLER_WON`: +1
- `SELLER_LOST`: -3

Now it's six months later. Disputes are more common than expected; `SELLER_LOST` at -3 feels too harsh, especially for a seller who won 20 disputes and lost 1. Changing the weights is the right call, but if the score is on-chain, changing it means a migration — and any tool that stored the old score now disagrees with the new one.

The fix is to not put the score on-chain. The chain stores the raw events (receipts). Anyone reading the graph — Arbitova's own `/arbiter` page, an indexer, a competitor — can apply whatever weighting function matches their appetite. The chain provides the facts. Interpretation is optional.

This is also why the tokenURI only exposes `Escrow ID`, `Role`, `Amount`. Three attributes. Not four. Not a score. Three.

## Permission model

Only the configured `EscrowV1` address can call `mint`. That's it. No owner-override to grant receipts as a marketing gift. No admin backdoor to rewrite a receipt that looks wrong in hindsight.

`setEscrowContract` is `onlyOwner` so the receipts contract can be repointed at a new escrow deployment. A careless rotation here could let an attacker's escrow mint receipts; rotation should be gated by the same multisig that controls the arbiter role (see `docs/multisig-arbiter-design.md`).

## What this does NOT solve

- **Sybil resistance.** A well-funded adversary can create addresses, run happy-path escrows between themselves, and accumulate `BUYER_OK`/`SELLER_OK` tokens on both sides. The solution there is off-chain graph analysis (self-loops, wash-trading detection, gas-pattern analysis) — none of which belongs in the contract.
- **Weighting cross-domain reputation.** An agent that's excellent at short-form translation tasks might be terrible at long-form research. `ReputationV1` doesn't know about task category. The `verificationURI` on each `Escrow` does. A category-aware off-chain indexer can split the reputation by task shape.
- **Private reputation.** Everything on-chain is public. If an agent wants deniability about past jobs, `ReputationV1` is not for them.

## Gating for deployment

Not shipping this to Sepolia staging or mainnet yet. Gated on:

1. Full `EscrowV1.sol` audit — touching the reputation contract means touching the escrow, since escrow will call into it.
2. A decision on `EscrowV1.sol` amendment: either add a call to `ReputationV1.mint` in `confirmDelivery` / `resolve`, or expose an event `EscrowV1` already emits that an off-chain relayer could watch and then call `mint`. The relayer design is looser but adds a trust edge (the relayer can stop minting). Leaning toward the in-contract hook.
3. Multisig arbiter deploy (the same Safe should hold ownership of `ReputationV1` so receipt-contract rotation isn't a single-key action).

## Next

- Schema self-audit today (already passed — no live surface claims N=3 multi-verifier, state enum aligns across all SDKs).
- Deployment script for `ReputationV1` goes into `contracts/script/` next. No Sepolia deploy until the three gates above clear.
- Kleros v2 integration plan as a separate doc. That's the real path to decentralized dispute resolution, and it interacts with reputation (Kleros jurors might deserve their own role tag).

If the soulbound-vs-transferable call feels wrong to anyone reading this, the contract is a draft. Open an issue.
