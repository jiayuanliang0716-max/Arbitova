---
slug: dev-log-020-wallet-without-a-wallet
title: "Dev Log #020 — A Wallet, Without a Wallet"
category: product
excerpt: "The biggest friction for agent payments isn't the payment. It's everything that has to be true before the agent can sign. I'm adding Coinbase CDP as a supported signer for Arbitova — not as a custody choice, but as the first integration that lets agents escrow USDC without anyone having to mint them a private key first."
cover_image: "https://images.unsplash.com/photo-1620321023374-d1a68fbc720d?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

Arbitova's escrow contract is non-custodial: the contract holds the money, the arbiter can only split disputed funds, nobody can sweep. But that's downstream of a bigger problem: for an agent to escrow money, the agent has to *have* money. Today that means someone manually mints a private key, funds it with USDC, stores it in a `.env`, hopes it doesn't leak. Friction is everywhere except where the product actually lives.

Coinbase CDP (Developer Platform) solves the "get this agent a wallet" problem well. What it didn't have was an escrow layer that wasn't coupled to custody. So I'm shipping a v0.1 adapter — `arbitova.cdp_adapter.CdpEscrowClient` — that routes escrow writes through a CDP-managed account without changing a line of the contract.

## What the adapter is

From `EscrowV1`'s view, a CDP-signed transaction is indistinguishable from a local-wallet-signed one. Both are just EOAs. The adapter just rearranges who holds the private key:

```
┌────────────┐       ┌──────────────────┐       ┌──────────────┐
│ Your agent │─────▶ │  CdpEscrowClient │─────▶ │ Coinbase CDP │
└────────────┘       └──────────────────┘       └──────┬───────┘
                              │                        │ signs
                              │                        ▼
                              │                ┌──────────────┐
                              └──────────────▶ │   Base L2    │
                                               │  EscrowV1    │
                                               └──────────────┘
```

The agent never sees a private key. The key lives inside CDP. Arbitova doesn't hold it. You don't hold it. CDP does. If that trust boundary is unacceptable, use `arbitova.path_b` directly with a local wallet — the same contract, same arbiter, same dispute semantics.

This is the point I want to land: **CDP is a signer choice, not a custody upgrade.** You can use CDP, or you can use a local wallet, or you can use whatever agent-native key infrastructure lands in 2026. Arbitova cares about the contract, not the bytes of the private key.

## What's in v0.1

- `CdpEscrowClient` with methods for `create_escrow`, `mark_delivered`, `confirm_delivery`, `dispute`, `cancel_if_not_delivered`. Each one approves / signs / sends through CDP.
- Reads (`get_escrow`) go direct via web3 — no point paying CDP rate limits for a view function.
- A `CdpNotInstalled` error type so callers who don't have the CDP SDK installed get a clean failure at construction, not a cryptic ImportError deep inside a method call.
- A minimal demo: `examples/path_b/cdp_buyer_demo.py` that runs approve → createEscrow → read state → (wait for seller) → confirm.

The USDC decimal handling is intentionally explicit: `amount_usdc=0.10` converts to `100000` base units via `int(round(x * 10**6))`. No float math near money except that one rounding. If you want precision below a penny, pass the raw integer.

## What v0.1 does NOT do

- **No reputation NFT minting.** That's a separate contract layer coming later.
- **No x402 integration.** The x402 adapter lives in `@arbitova/x402-adapter` (JavaScript) and handles the payment negotiation; CDP is orthogonal. Combining them is on the roadmap.
- **No auto-dispute.** If the seller misses the delivery window, you still have to call `cancel_if_not_delivered` yourself. Adding auto-dispute would mean the adapter holds state about deadlines, and I'd rather the contract remain the single source of truth.
- **No mainnet.** Sepolia only. Mainnet is gated on: multisig arbiter (3-of-5 Safe), full contract audit, Kleros v2 integration plan. See `docs/multisig-arbiter-design.md` for the multisig piece.

## The part I want to be honest about

CDP adds a trust edge. CDP can see that Arbitova-using agents exist. CDP's SLA and rate limits and pricing become load-bearing for anyone using the adapter. If CDP has an outage, the agents using this adapter cannot sign. That's *different* from "Arbitova has an outage" — the contract works fine; it's the signer that's down.

I think this trade is worth it for the segment of agents that would otherwise not exist at all because nobody solved their signing-stack-before-they-can-pay problem. But I want the trade to be visible, not buried. That's why the adapter is a separate module (`arbitova.cdp_adapter`) rather than the default import path — if you're reaching for CDP, you know you're reaching for it.

## Next

- x402-adapter v0.1-alpha is up in JavaScript. Next: end-to-end between the two, where a CDP-signed agent pays another agent via x402 with escrow in the middle.
- Multisig arbiter on Sepolia staging — signers identified, Safe deployment next.
- One more pass on the `/integrate` page to list the CDP path with the same three-card format as the raw / SDK paths.

If you've tried this adapter and something broke, open an issue on `jiayuanliang0716-max/a2a-system`. Every failure mode I don't know about is a bug I can't fix.
