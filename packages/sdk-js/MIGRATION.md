# Migrating from @arbitova/sdk v2 (custodial) to v3 (non-custodial)

**v3.0.0** is a rewrite. It has no API surface in common with v2.x. If you are on v2.x and this breaks you, pin to `@arbitova/sdk@^2.3.1`.

## What changed

Arbitova has pivoted from a custodial escrow service (API keys, hosted wallets, centralized orders database) to a non-custodial on-chain escrow with a public arbiter. This is a strategic pivot, not a typo release.

| | v2.x (custodial) | v3.x (non-custodial) |
|---|---|---|
| Auth | `X-API-Key` header | Private key or browser wallet signs tx |
| Custody | Arbitova held funds | EscrowV1 contract on Base holds USDC |
| Settlement | API call → centralized DB | On-chain `confirmDelivery` / `resolve` |
| Disputes | Support ticket | On-chain `dispute` → arbiter → `resolve` |
| Module format | CommonJS | ESM |
| Entry | `Arbitova({ apiKey })` | `Arbitova.fromPrivateKey({ privateKey })` |

## v2 → v3 example

**v2 (deprecated):**
```js
const { Arbitova } = require('@arbitova/sdk');
const client = new Arbitova({ apiKey: process.env.ARB_API_KEY });
const order = await client.orders.create({ seller: 'seller_id', amount: 5.00 });
```

**v3:**
```js
import { Arbitova } from '@arbitova/sdk';
const client = await Arbitova.fromPrivateKey({ privateKey: process.env.BUYER_PK });
const { escrowId, txHash } = await client.createEscrow({
  seller: '0xSellerAddress...',
  amount: '5.00',
  deliveryHours: 24,
  reviewHours: 24,
  verificationURI: 'ipfs://...spec.json',
});
```

## Why the change

1. **Non-custodial is the right default for agent payments.** A running arbiter should not also hold principal.
2. **Regulatory clarity.** Holding fiat-equivalent funds triggers money transmitter obligations in many jurisdictions. Non-custodial shifts that surface off Arbitova.
3. **Verifiability.** Every escrow + verdict is on-chain. Third parties can independently audit state and precedent.
4. **Composability.** v3 SDK works with any EIP-1193 wallet, any standard ethers provider, any other on-chain A2A tooling.

## If you need v2

```bash
npm install @arbitova/sdk@^2.3.1
```

v2 will continue to work against `api.arbitova.com` until deprecation notice. No new features will ship on the v2 line.

## Spec

v3 conforms to [A2A Escrow Protocol RFC v0.1](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/spec/A2A-ESCROW-RFC-v0.1.md). Any third-party implementation of that spec should be drop-in compatible with this SDK when pointed at the corresponding contract.
