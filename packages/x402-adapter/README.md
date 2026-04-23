# @arbitova/x402-adapter

**Status:** v0.1 alpha — API is expected to change before 1.0. Do not use in production.

Wrap an [x402](https://github.com/coinbase/x402) payment flow with Arbitova
non-custodial USDC escrow and a configurable dispute window. Opt-in per
response via one extra header.

## Why

x402 is the right primitive for pay-on-response work (deterministic APIs).
For work where delivery is asynchronous, subjective, or disputable —
research agents, translation, long-running compute — there is no review
window. Once paid, paid.

This adapter:

1. Lets a server opt in to escrow by returning `X-Arbitova-Escrow: <address>@<chain>` alongside the normal x402 headers.
2. Routes the buyer's payment through `EscrowV1.createEscrow` instead of a direct transfer.
3. Gives the buyer a `confirmLast()` / `disputeLast({ reason })` handle. If no action, the escrow can be released on-chain via `escalateIfExpired` once the review window closes.

The adapter **never holds keys**. Signing goes through whatever signer you pass in.

## Install

```bash
npm install @arbitova/x402-adapter @arbitova/sdk ethers
```

## Basic use

```js
import { withEscrow } from '@arbitova/x402-adapter';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const signer   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const paidFetch = withEscrow(fetch, {
  signer,
  escrowAddress: '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC',
  usdcAddress:   '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  defaultReviewWindow:   24 * 60 * 60, // 24 h
  defaultDeliveryWindow: 24 * 60 * 60,
});

const res = await paidFetch('https://api.example.com/research', {
  method: 'POST',
  body: JSON.stringify({ query: 'Is X still CEO of Y?' }),
});

// Happy path:
await paidFetch.confirmLast();

// Or dispute within the review window:
// await paidFetch.disputeLast({ reason: 'Claims unverifiable' });
```

## Server-side: advertising escrow-compatibility

Return these headers on a 402 response:

```
HTTP/1.1 402 Payment Required
X-402-Price: 0.10 USDC
X-402-To: 0xSELLER...
X-Arbitova-Escrow: 0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC@84532
X-Arbitova-DeliveryWindow: 3600
```

The adapter then:
1. Calls `USDC.approve(escrow, price)`.
2. Calls `EscrowV1.createEscrow(seller, price, deliveryWindow, reviewWindow, verificationURI)`.
3. Retries the original request with `X-Arbitova-Escrow-Ref: <contract>:<id>` so the seller can correlate.

Servers MAY require the ref header on the retry and reject requests that arrive without it.

## Headers, at a glance

| Header | Direction | Meaning |
|---|---|---|
| `X-Arbitova-Escrow` | server → client (on 402) | `<contract address>@<chainId>` — opt in. |
| `X-Arbitova-DeliveryWindow` | server → client (on 402) | seconds the seller has to `markDelivered` (default: adapter config). |
| `X-Arbitova-Escrow-Ref` | client → server (on retry) | `<contract>:<id>` — lets the seller look up the escrow. |

If the server does not send `X-Arbitova-Escrow`, the adapter returns the raw 402 unchanged. You can chain it with any other x402 handler.

## What the adapter does NOT do

- Hold or generate private keys.
- Auto-confirm. You must call `confirmLast()` (or the seller calls `escalateIfExpired` once the window closes).
- Sign on non-Base chains. v0.1 is Base Sepolia only. Multi-chain is on the Arbitova roadmap.
- Handle non-USDC payments. Price header parsing is strict — USDC or raw base units only.

## Running tests

```bash
npm test
```

Unit tests stub out the contracts and run without a chain.

E2E against live Sepolia (requires `ARBITOVA_PRIVATE_KEY` and test USDC) will live in `../../scripts/x402-adapter-e2e.js`. Not shipped in v0.1-alpha.0.

## License

MIT. See root of repo.
