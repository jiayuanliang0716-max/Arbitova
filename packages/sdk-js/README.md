# @arbitova/sdk

JS/TS SDK for [Arbitova](https://arbitova.com) — non-custodial USDC escrow for agent-to-agent payments on Base.

No API keys. No registration. Your Ethereum address is your identity.

## Install

```bash
npm install @arbitova/sdk ethers
```

## Quick start — buyer agent

```js
import { Arbitova } from '@arbitova/sdk';

const client = await Arbitova.fromPrivateKey({ privateKey: process.env.BUYER_PK });

const { escrowId, txHash } = await client.createEscrow({
  seller: '0xSellerAddress...',
  amount: '5.00',
  deliveryHours: 24,
  reviewHours: 24,
  verificationURI: 'https://example.com/spec.json',
});

console.log(`Escrow #${escrowId} — ${client.explorerTx(txHash)}`);
```

## Quick start — seller agent

```js
const client = await Arbitova.fromPrivateKey({ privateKey: process.env.SELLER_PK });

// Watch for escrows targeting you
client.onEscrowCreated((ev) => {
  if (ev.seller.toLowerCase() === (await client.address()).toLowerCase()) {
    console.log('New escrow:', ev.id, 'for', ev.amount, 'USDC');
  }
});

// When work is done
await client.markDelivered({
  escrowId: '17',
  deliveryPayloadURI: 'ipfs://QmDelivery...',
});
```

## Quick start — browser wallet

```js
import { Arbitova } from '@arbitova/sdk';
const client = await Arbitova.fromWallet(window.ethereum);
await client.confirmDelivery('17');
```

## API

All methods are async. Write methods require a signer (private key or wallet).

| Method | Role | Description |
|---|---|---|
| `Arbitova.fromPrivateKey({ privateKey })` | — | Create client signed by a private key |
| `Arbitova.fromWallet(window.ethereum)` | — | Create client using a browser wallet |
| `Arbitova.fromReadOnly()` | — | Read-only client (no signing) |
| `createEscrow({ seller, amount, deliveryHours, reviewHours, verificationURI })` | buyer | Lock USDC. Approves first if needed. Returns `{ escrowId, txHash, ... }` |
| `markDelivered({ escrowId, deliveryPayloadURI })` | seller | Commits `keccak256(URI)` on-chain |
| `confirmDelivery(escrowId)` | buyer | Happy path — pays seller (minus 0.5%) |
| `dispute(escrowId, reason)` | buyer or seller | Opens dispute; reason emitted in event |
| `cancelIfNotDelivered(escrowId)` | buyer | After delivery deadline if seller no-showed |
| `escalateIfExpired(escrowId)` | anyone | After review deadline — auto-release to seller |
| `getEscrow(escrowId)` | — | Full escrow state |
| `getUsdcBalance(addr?)` | — | USDC balance |
| `listEscrowsForAddress(role, addr?)` | — | Scan every escrow where address is buyer or seller |
| `onEscrowCreated / onDelivered / onReleased / onDisputed / onResolved / onCancelled` | — | Event subscriptions via ethers `.on()` |
| `explorerTx(hash)` / `explorerAddr(addr)` | — | Basescan URL helpers |
| `Arbitova.keccakURI(uri)` | static | Compute deliveryHash for an off-chain URI |

## Event stream (SSE)

For agents that want push notifications instead of polling, use the Arbitova event stream:

```js
import { subscribeEvents } from '@arbitova/sdk/events';

const unsub = subscribeEvents({
  address: '0xYourAgentAddress',
  onEvent: (ev) => console.log(ev.type, ev.id),
});
```

## Networks

| Key | Description |
|---|---|
| `base-sepolia` (default) | Production contract on Base Sepolia testnet, real Circle USDC |
| `base-sepolia-test` | Test contract with mock USDC (for integration testing) |

```js
const client = await Arbitova.fromPrivateKey({
  privateKey: '...',
  network: 'base-sepolia-test',
});
```

## Verification specs

Structure your `verificationURI` per [arbitova-spec-v1](https://arbitova.com/schemas/). Two modes:

- **`manual`** — prose for humans (buyer, seller, arbiter)
- **`programmatic`** — declares an HTTPS verifier endpoint for automated checks

## Fees

| When | Fee | Paid by |
|---|---|---|
| `confirmDelivery` or `escalateIfExpired` | 0.5% | deducted from seller payout |
| Arbiter resolves a dispute | 2% | split per arbiter verdict |

## License

MIT
