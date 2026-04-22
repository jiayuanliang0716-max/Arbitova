# Migration Guide: Path A (custodial API, deprecated) → Path B (on-chain, current)

**Status (2026-04-22):** Path A is deprecated. New development should use Path B. The old `@arbitova/sdk@^2.x` packages remain installable on npm but receive no further updates.

## Where to find what

| You want | Use |
|---|---|
| JS/TS, current | [`@arbitova/sdk@^3`](../packages/sdk-js/) — Path B, non-custodial |
| Python, current | `pip install 'arbitova[path_b]'` — `from arbitova import path_b` |
| MCP server, current | [`@arbitova/mcp-server@^4`](../mcp-server/) — six on-chain tools |
| 15-minute walkthrough | [`docs/tutorials/15-min-paid-agent.md`](../docs/tutorials/15-min-paid-agent.md) |
| MCP-specific migration | [`mcp-server/MIGRATION.md`](../mcp-server/MIGRATION.md) |

## What changed

**Path A** (v2.x): Arbitova held funds in a custodial backend. Auth was an `ARBITOVA_API_KEY`. Simple HTTP, no wallet required, but Arbitova was the custodian.

**Path B** (v3+): Funds flow directly through the `EscrowV1` smart contract on Base. You hold your own wallet and private key. Arbitova never touches the money — it can only resolve disputes by submitting a verdict the contract accepts. Every action is an on-chain transaction.

| Aspect | Path A | Path B |
|--------|--------|--------|
| Fund custody | Arbitova custodial balance | On-chain EscrowV1 |
| Auth | `ARBITOVA_API_KEY` | Your EVM private key |
| Calls | REST HTTP | ethers v6 against the contract |
| New dep | — | `ethers` v6 |
| Fees | off-chain bookkeeping | Base gas + 0.5% / 2% contract fee |
| State enum | `PENDING / CONFIRMED / …` | `CREATED / DELIVERED / RELEASED / DISPUTED / RESOLVED / CANCELLED` |
| Current status | deprecated | supported, pre-mainnet audit |

## Side-by-side

### Creating an escrow

**Path A (deprecated)**
```js
const { Arbitova } = require('@arbitova/sdk');  // v2.x
const client = new Arbitova({ apiKey: process.env.ARBITOVA_API_KEY });
const order = await client.escrow('svc_abc123', { requirements: { task: '…' } });
```

**Path B (current)**
```js
import { Arbitova } from '@arbitova/sdk';  // v3+

const buyer = await Arbitova.fromPrivateKey({ privateKey: process.env.BUYER_PK });

const { escrowId, txHash } = await buyer.createEscrow({
  seller: '0xSELLER',
  amount: '50.00',
  deliveryHours: 24,
  reviewHours: 24,
  verificationURI: 'https://your-host/criteria.json',
});
```

Python ships a flat-function surface (`arbitova_create_escrow(...)`, `arbitova_mark_delivered(...)`, etc.) under `from arbitova import path_b` for frameworks that prefer plain functions over a client class. The JS SDK exposes the same operations as methods on the `Arbitova` client shown above.

### Confirming delivery

**Path A**
```js
await client.confirm(order.id);  // server picks side
```

**Path B**
```js
// Fetch + verify delivery first. See the buyer-verification prompt.
// Only after checking every criterion:
await buyer.confirmDelivery(escrowId);
// If anything is wrong:
await buyer.dispute(escrowId, 'Criterion 2 not met: …');
```

Silence is safe in Path B — if you neither confirm nor dispute, the review window expires and the escrow escalates to arbitration.

### Python

**Path A (deprecated)**
```python
from arbitova import Arbitova
client = Arbitova(api_key=os.environ["ARBITOVA_API_KEY"])
order = client.escrow("svc_abc123", requirements={"task": "summarize"})
```

**Path B (current)**
```python
from arbitova import path_b

result = path_b.arbitova_create_escrow(
    seller="0xSELLER",
    amount=50,
    verification_uri="https://your-host/criteria.json",
)
# result["ok"], result["escrow_id"], result["tx_hash"]
```

## Env vars for Path B

```sh
ARBITOVA_RPC_URL=https://sepolia.base.org
# or https://mainnet.base.org once we're on mainnet

ARBITOVA_ESCROW_ADDRESS=0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC
# Base Sepolia EscrowV1 (mainnet address TBA after audit)

ARBITOVA_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
# Base Sepolia USDC. Mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

ARBITOVA_AGENT_PRIVATE_KEY=0x...
# Signs locally. Never transmitted. Omit in some MCP setups for read-only mode.
```

## MCP resources (Path B)

The MCP server exposes four resources any agent can load:

```
arbitova://prompts/buyer-verification       verification checklist for buyers
arbitova://prompts/seller-delivery          delivery checklist for sellers
arbitova://prompts/arbitrator-self-check    structure for LLM-as-arbitrator
arbitova://resources/escrow-abi             EscrowV1 ABI (JSON)
```

## FAQ

**Do I have to migrate?** If you want bug fixes, new features, or mainnet support — yes. The v2.x SDKs are frozen where they are.

**Can I use both in the same project?** Not in one `@arbitova/sdk` install — v2 and v3 are incompatible exports. You can keep an old project on v2 and start a new one on v3.

**Why was Path A deprecated?** Four structural issues: DB-vs-onchain balance drift, custody-wallet gas funding, single `ADMIN_KEY` compromise surface, and single `WALLET_ENCRYPTION_KEY` point of failure. Removing custody eliminates all four. See [Dev Log #013](https://arbitova.com/blog) for the full write-up.

**Is there an off-ramp for v2 users?** Email the maintainer or open an issue — we can help you plan the switch. No PRs are being merged against v2 internals.
