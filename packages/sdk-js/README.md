# @arbitova/sdk

**Non-custodial USDC escrow for agent-to-agent payments on Base.**

Two agents lock USDC into a contract, one delivers, the other confirms or disputes, and a neutral arbiter resolves. Arbitova never holds the money — the contract does.

No API keys. No registration. No custody. Your Ethereum address is your identity.

```bash
npm install @arbitova/sdk ethers
```

Contract: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` on Base Sepolia (mainnet launching after audit)
Spec: [`A2A-ESCROW-RFC-v0.1`](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/spec/A2A-ESCROW-RFC-v0.1.md)
Live UI: [arbitova.com/pay](https://arbitova.com/pay)

---

## Why this exists

Every A2A / agent-commerce spec in the wild — MCP, Google's A2A, ERC-7683, Coinbase's Agent Commerce — defines *how agents talk*. None of them define *how money moves when the agents don't trust each other*.

Arbitova is the missing settlement primitive:

- **Deterministic state machine.** `createEscrow → markDelivered → {confirmDelivery | dispute → resolve | cancel}`. No hidden branches, no admin override.
- **No auto-release after timeout.** Review windows expire into `DISPUTED`, not into seller payout. Silence is safer than a wrong confirmation.
- **Content-hash pinned on-chain.** Sellers can't swap the delivery file after the buyer inspects.
- **Verdict transparency.** Every arbiter decision is a signed JSON blob; its `keccak256` is stored on-chain. Anyone can audit.

**This is not a marketplace.** There is no Arbitova account, no listing fee, no Arbitova Pro tier. The protocol is the whole product.

---

## 30-second quickstart

Two terminals. Both need a Base Sepolia private key with some test USDC + a pinch of ETH for gas.
Faucet: https://faucet.circle.com/ (Base Sepolia USDC) · gas: https://www.alchemy.com/faucets/base-sepolia

### Buyer

```js
// buyer.mjs
import { Arbitova } from '@arbitova/sdk';

const buyer = await Arbitova.fromPrivateKey({ privateKey: process.env.BUYER_PK });

const { escrowId, txHash } = await buyer.createEscrow({
  seller: process.env.SELLER_ADDRESS,
  amount: '5.00',                         // USDC
  deliveryHours: 24,
  reviewHours: 24,
  verificationURI: 'https://example.com/spec.json',
});

console.log(`Escrow #${escrowId} locked — ${buyer.explorerTx(txHash)}`);
```

### Seller

```js
// seller.mjs
import { Arbitova } from '@arbitova/sdk';

const seller = await Arbitova.fromPrivateKey({ privateKey: process.env.SELLER_PK });

seller.onEscrowCreated(async (ev) => {
  if (ev.seller.toLowerCase() !== (await seller.address()).toLowerCase()) return;

  console.log(`New escrow #${ev.id}: ${ev.amount} USDC from ${ev.buyer}`);

  // ...do the work, then:
  const deliveryContent = Buffer.from('hello, buyer');
  await seller.markDelivered({
    escrowId: ev.id,
    deliveryPayloadURI: 'https://example.com/receipt.json',
    deliveryContentBytes: deliveryContent,   // content-hash pinned on-chain
  });
});
```

### Buyer confirms (happy path)

```js
await buyer.confirmDelivery(escrowId);   // seller gets 4.975 USDC, fee 0.025 USDC
```

### Buyer disputes (sad path)

```js
await buyer.dispute(escrowId, 'Delivery incomplete — criterion #2 failed');
// arbiter picks it up, signs a verdict, calls resolve(buyerBps, sellerBps, verdictHash)
```

That's the whole thing.

---

## Lifecycle

```
                      ┌──────────────────┐
                      │     CREATED      │ buyer locked USDC
                      └────────┬─────────┘
                               │
                               ▼ seller.markDelivered()
                      ┌──────────────────┐
                      │    DELIVERED     │ deliveryHash on-chain
                      └────────┬─────────┘
                               │
        buyer.confirmDelivery()│        │ buyer.dispute()
                               │        │ or seller.dispute()
                               ▼        ▼
                   ┌─────────────┐  ┌──────────┐
                   │  RELEASED   │  │ DISPUTED │ waiting for arbiter
                   └─────────────┘  └────┬─────┘
                                         │ arbiter.resolve(bps split + verdictHash)
                                         ▼
                                   ┌──────────┐
                                   │ RESOLVED │
                                   └──────────┘
```

Two terminal states not drawn: `CANCELLED` (buyer calls `cancelIfNotDelivered` after delivery window) and auto-escalation into `DISPUTED` if the review window expires without confirmation.

---

## Browser wallet

```js
import { Arbitova } from '@arbitova/sdk';

const client = await Arbitova.fromWallet(window.ethereum);
await client.confirmDelivery('17');
```

Works with any EIP-1193 wallet (MetaMask, Coinbase Wallet, Rainbow, Rabby, etc.).

---

## Framework integrations

Three reference A2A demos, all end-to-end on Base Sepolia with a live AI arbiter:

- **[Claude Agent SDK](https://github.com/jiayuanliang0716-max/Arbitova/tree/master/examples)** — in-process MCP tools
- **[LangGraph](https://github.com/jiayuanliang0716-max/Arbitova/tree/master/examples)** — ReAct agent
- **[CrewAI](https://github.com/jiayuanliang0716-max/Arbitova/tree/master/examples)** — Agent + Task + Crew

Python agents: `pip install arbitova[path_b]`, then `from arbitova import path_b`. Same contract surface, same verdicts.

MCP server: `npm install @arbitova/mcp-server` — six on-chain tools (same contract surface) for any MCP client.

---

## Networks

| Key | Description |
|---|---|
| `base-sepolia` (default) | Production contract, real Circle USDC |
| `base-sepolia-test` | Test contract with mock USDC for CI |

```js
const client = await Arbitova.fromPrivateKey({
  privateKey: process.env.PK,
  network: 'base-sepolia-test',
});
```

Base mainnet launches after external audit + multisig arbiter migration. Watch [Dev Log](https://github.com/jiayuanliang0716-max/Arbitova) for the announcement.

---

## Fees

| When | Fee | Paid by |
|---|---|---|
| `confirmDelivery` / `escalateIfExpired` | 0.5% | deducted from seller payout |
| Arbiter resolves a dispute | 2% | split per arbiter verdict |

Fees accrue in the contract. The protocol runs on them; there is no subscription.

---

## API

All methods async. Write methods require a signer (private key or browser wallet).

| Method | Role | Description |
|---|---|---|
| `Arbitova.fromPrivateKey({ privateKey, network? })` | — | Client signed by private key |
| `Arbitova.fromWallet(window.ethereum)` | — | Client using an EIP-1193 wallet |
| `Arbitova.fromReadOnly({ network? })` | — | Read-only (no signing) |
| `createEscrow({ seller, amount, deliveryHours, reviewHours, verificationURI })` | buyer | Lock USDC (auto-approves). Returns `{ escrowId, txHash, receipt }` |
| `markDelivered({ escrowId, deliveryPayloadURI, deliveryContentBytes? })` | seller | Commits `keccak256(content)` (or URI) on-chain |
| `confirmDelivery(escrowId)` | buyer | Happy path — pays seller (minus 0.5%) |
| `dispute(escrowId, reason)` | buyer or seller | Opens dispute; `reason` emitted in event |
| `cancelIfNotDelivered(escrowId)` | buyer | After delivery deadline if seller no-showed |
| `escalateIfExpired(escrowId)` | anyone | After review deadline — forces DISPUTED, **not** auto-release |
| `getEscrow(escrowId)` | — | Full on-chain state |
| `getUsdcBalance(addr?)` | — | USDC balance |
| `listEscrowsForAddress(role, addr?)` | — | Scan escrows where address is `buyer` or `seller` |
| `onEscrowCreated / onDelivered / onReleased / onDisputed / onResolved / onCancelled` | — | Event subscriptions |
| `explorerTx(hash)` / `explorerAddr(addr)` | — | Basescan URL helpers |
| `Arbitova.keccakURI(uri)` | static | Compute `deliveryHash` for an off-chain URI |
| `subscribeEvents({ address, onEvent })` | — | Server-sent events push stream (alternative to polling) |

---

## Verification specs

Your `verificationURI` should link to a JSON document defining what "done" means. Two modes:

- **`manual`** — human-readable prose for buyer, seller, and arbiter
- **`programmatic`** — an HTTPS endpoint an arbiter can hit to get a pass/fail

Schema: [arbitova.com/schemas/](https://arbitova.com/schemas/) · Reference: [RFC v0.1](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/spec/A2A-ESCROW-RFC-v0.1.md)

---

## Security

- Contract source: [`contracts/src/EscrowV1.sol`](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/contracts/src/EscrowV1.sol)
- 66/66 Foundry tests green · TOCTOU hardened · 100% line coverage
- Sepolia E2E evidence: [`SEPOLIA_E2E_REPORT.md`](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/SEPOLIA_E2E_REPORT.md)
- Bounty program (v0 draft): [`security/bug-bounty-v0.md`](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/security/bug-bounty-v0.md) — live on Immunefi after mainnet deploy
- Responsible disclosure: `security@arbitova.com` (alias coming; until then `jiayuanliang0716@gmail.com`)

---

## Migrating from v2 (custodial)

v3 is a rewrite. If you have working v2 code, pin to `@arbitova/sdk@^2.3.1` until you're ready — v3 doesn't share any API surface with v2. Migration guide: [`MIGRATION.md`](./MIGRATION.md).

---

## License

MIT · [github.com/jiayuanliang0716-max/Arbitova](https://github.com/jiayuanliang0716-max/Arbitova)
