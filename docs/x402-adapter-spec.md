# x402-adapter Specification (v0.1 draft)

Status: design draft. No code yet under `packages/x402-adapter/`.
Author: Arbitova / 2026-04-23.
Audience: x402 builders and Coinbase CDP devrel.

---

## Problem

The x402 protocol (HTTP 402 Payment Required, as framed by Coinbase's
x402 proposal) gives agents a clean way to **pay-on-response**: the
server replies `402` with a price, the client pays, gets the work,
moves on. This is great for low-latency, verifiable delivery — an API
returns data, the proof is the response itself.

It gets awkward when **delivery is asynchronous, subjective, or
disputable**:

- A research agent takes 90 seconds to produce a report. Did it do a
  real search or hallucinate?
- A translation agent returns "done." Was the translation competent?
- A compute job produces output hours later. Was the spec followed?

x402 alone has no dispute window. Once you've paid, you've paid.
Agent-to-agent markets with any quality variance need something that
sits between "pay upfront" and "pay on response."

## Proposed scope

`@arbitova/x402-adapter` wraps an x402 payment flow so that:

1. The buyer **reserves** USDC in `EscrowV1` instead of sending it.
2. The server returns the response as normal.
3. A configurable **review window** (default 24h) opens, during which
   the buyer can call `dispute`.
4. If no dispute, the contract releases funds on `confirmDelivery`
   (or anyone can call `escalateIfExpired` once the window closes).
5. If disputed, the existing Arbitova arbiter path runs.

The adapter is a thin compatibility shim. It does not change the
`EscrowV1` contract. It adds one convention on top of x402:

> **Convention:** an x402 402 response MAY include an optional
> `X-Arbitova-Escrow: <contract address>@<chain>` header. If present,
> the server is advertising that this payment is escrow-compatible
> and will accept delivery via the escrow lifecycle.

## Out of scope

- Signing on the user's behalf. Adapter MUST NOT hold private keys.
- Hosted dispute resolution. Dispute resolution routes to whatever
  arbiter the `EscrowV1` instance was configured with (default:
  Arbitova-operated Claude arbiter with confidence gate).
- Non-USDC payment. v0.1 is USDC-only on Base, same as EscrowV1.

## Proposed API

### Client side

```js
import { withEscrow } from '@arbitova/x402-adapter';
import { fetch } from 'undici';

const paidFetch = withEscrow(fetch, {
  signer,                        // ethers Signer
  usdc,                          // ERC20 contract
  escrow,                        // EscrowV1 contract
  defaultReviewWindow: 86400,    // seconds
  defaultDeliveryWindow: 86400,  // seconds
  verificationUri: (req) => `ipfs://${req.url}.json`,
});

// Behavior identical to x402 except payment is escrowed, not sent.
const res = await paidFetch('https://api.example.com/research', {
  method: 'POST',
  body: JSON.stringify({ query: 'Is X still CEO of Y?' }),
});

// To confirm (happy path):
await paidFetch.confirmLast();

// To dispute (within reviewWindow):
await paidFetch.disputeLast({ reason: 'Claims unverifiable' });
```

### Server side (documentation only — no SDK code)

A server advertising escrow-compatibility returns:

```
HTTP/1.1 402 Payment Required
X-402-Price: 0.10 USDC
X-402-To: 0xSELLER...
X-Arbitova-Escrow: 0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC@84532
X-Arbitova-DeliveryWindow: 3600
```

The adapter sees `X-Arbitova-Escrow` and routes through
`createEscrow` instead of a direct transfer. If the header is absent
the adapter falls through to normal x402 behavior.

## Compatibility promises

- **If you already speak x402:** your server works unchanged. The
  adapter's escrow path is opt-in via response header.
- **If you already use EscrowV1 directly:** the adapter uses the same
  contract. No migration. A buyer escrow created via the adapter is
  visible in `/verdicts` and the `/pay/` dashboard.
- **If you use neither:** adapter still works as a normal `fetch`
  replacement. You just don't get escrow semantics.

## Security notes

- Adapter never exposes `signer` beyond `approve` / `createEscrow` /
  `confirmDelivery` / `dispute`. All signatures are scoped.
- `verificationUri` callback is called synchronously on each request.
  If it throws, the adapter falls back to a keccak256 of the request
  body (matching `markDelivered` convention).
- Adapter does NOT call `cancelIfNotDelivered` automatically. That's
  a manual call the buyer makes if the seller disappears — we don't
  want "timeout" races between the adapter and the contract.

## Open questions

1. **Seller-side SDK?** v0.1 is client-only. A server SDK that reads
   the 402, signs `markDelivered`, and emits the hash would be a
   natural v0.2.
2. **Multi-chain.** EscrowV1 is Base Sepolia today. An x402 adapter
   probably wants Base mainnet and Arbitrum/Solana on the medium-term
   roadmap. Kept out of v0.1.
3. **Relationship to Coinbase CDP.** The adapter is signer-agnostic;
   CDP-managed accounts work the same as an injected wallet. A thin
   CDP adapter (`@arbitova/x402-adapter/cdp`) may be worth shipping
   alongside v0.1 to reduce integration friction.

## v0.1 deliverables

- `packages/x402-adapter/` monorepo package
- `withEscrow(fetch, opts)` export
- Unit tests against a local Hardhat/Anvil fork with USDC + EscrowV1
- Integration test: real Base Sepolia end-to-end using the existing
  Sepolia EscrowV1 and a minimal test seller
- README with the two conventions above, spelled out
- Dev Log entry explaining the convention choice and why it's opt-in

Timeline: implementation starts after this spec is reviewed. No
external commitments until v0.1 ships and smokes end-to-end.
