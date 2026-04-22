# Arbitova

**Non-custodial USDC escrow + AI arbitration for agent-to-agent payments on Base.**

Two agents lock USDC into a contract, one delivers, the other confirms or disputes, and a neutral AI arbiter resolves. Arbitova never holds the money — the contract does.

No API keys. No registration. No custody. Your Ethereum address is your identity.

- Contract: [`EscrowV1`](./contracts/src/EscrowV1.sol) at `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` on Base Sepolia (mainnet launching after audit)
- Spec: [`A2A-ESCROW-RFC-v0.1`](./spec/A2A-ESCROW-RFC-v0.1.md)
- Live UI: [arbitova.com/pay](https://arbitova.com/pay)
- 15-minute tutorial: [`docs/tutorials/15-min-paid-agent.md`](./docs/tutorials/15-min-paid-agent.md)

---

## Why this exists

Every A2A / agent-commerce spec in the wild — MCP, Google's A2A, ERC-7683, Coinbase's Agent Commerce — defines *how agents talk*. None of them define *how money moves when the agents don't trust each other*.

Arbitova is the missing settlement primitive:

- **Deterministic state machine.** `createEscrow → markDelivered → {confirmDelivery | dispute → resolve | cancel}`. No hidden branches, no admin override.
- **No auto-release after timeout.** Review windows expire into `DISPUTED`, not into seller payout. Silence is safer than a wrong confirmation.
- **Content-hash pinned on-chain.** Sellers can't swap the delivery file after the buyer inspects.
- **Verdict transparency.** Every arbiter decision is a signed JSON blob; its `keccak256` is stored on-chain. Anyone can audit.

This is not a marketplace. There is no Arbitova account, no listing fee, no Pro tier. The protocol is the whole product.

---

## Quick start — Node.js SDK

```bash
npm install @arbitova/sdk ethers
```

```js
import { Arbitova } from '@arbitova/sdk';

const buyer = await Arbitova.fromPrivateKey({ privateKey: process.env.BUYER_PK });

const { escrowId, txHash } = await buyer.createEscrow({
  seller: process.env.SELLER_ADDRESS,
  amount: '5.00',
  deliveryHours: 24,
  reviewHours: 24,
  verificationURI: 'https://example.com/spec.json',
});

console.log(`Escrow #${escrowId} locked — ${buyer.explorerTx(txHash)}`);
```

Seller-side, arbiter-side, browser wallet integration: see [`packages/sdk-js/README.md`](./packages/sdk-js/README.md).

## Quick start — Python SDK

```bash
pip install "arbitova[path_b]"
```

```python
from arbitova import path_b

result = path_b.arbitova_create_escrow(
    seller="0x...",
    amount=5.00,
    verification_uri="https://example.com/spec.json",
)
print(result)
```

## Quick start — Claude / any MCP client

```json
{
  "mcpServers": {
    "arbitova": {
      "command": "npx",
      "args": ["-y", "@arbitova/mcp-server"],
      "env": {
        "ARBITOVA_RPC_URL": "https://sepolia.base.org",
        "ARBITOVA_ESCROW_ADDRESS": "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
        "ARBITOVA_USDC_ADDRESS": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "ARBITOVA_AGENT_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Six tools: `arbitova_create_escrow`, `arbitova_mark_delivered`, `arbitova_confirm_delivery`, `arbitova_dispute`, `arbitova_cancel_if_not_delivered`, `arbitova_get_escrow`. All sign locally via `ethers` v6. Your private key never leaves the process.

Omit `ARBITOVA_AGENT_PRIVATE_KEY` for read-only introspection mode (useful for observability).

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

## Framework reference agents

Three end-to-end A2A demos on Base Sepolia with a live AI arbiter:

- **[Claude Agent SDK](./demo)** — in-process MCP tools
- **[LangGraph](./demo)** — ReAct agent, buyer + seller + arbiter
- **[CrewAI](./demo)** — Agent + Task + Crew

Each demo runs the full CREATED → DELIVERED → CONFIRMED (or DISPUTED → RESOLVED) flow with real on-chain transactions.

---

## Packages

| Package | Purpose |
|---|---|
| [`@arbitova/sdk`](https://www.npmjs.com/package/@arbitova/sdk) | Node.js / browser SDK (`ethers` v6) |
| [`arbitova`](https://pypi.org/project/arbitova/) | Python SDK, install with `[path_b]` extra for on-chain support |
| [`@arbitova/mcp-server`](https://www.npmjs.com/package/@arbitova/mcp-server) | MCP server (6 on-chain tools) for Claude Desktop, Claude Code, any MCP client |

Each ships the same six-entrypoint surface so an agent using the Python SDK can settle with an agent using the MCP server — they're hitting the same contract.

---

## Fees

| When | Fee | Paid by |
|---|---|---|
| `confirmDelivery` / review-window expiry auto-settle | 0.5% | deducted from seller payout |
| Arbiter resolves a dispute | 2% | split per arbiter verdict |

Fees accrue in the contract. The protocol runs on them; there is no subscription.

---

## Networks

| Network | Status | Contract |
|---|---|---|
| Base Sepolia | live, real Circle USDC | `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` |
| Base mainnet | pending audit + multisig arbiter | TBA |

Watch the [Dev Log](https://arbitova.com/blog) for mainnet launch.

---

## Legacy (Path A)

v2.x of the SDKs and v3.4.0 of the MCP server were a custodial HTTP client against `api.arbitova.com`. That architecture had four structural problems (DB-vs-onchain drift, custody wallet gas, single `ADMIN_KEY`, single `WALLET_ENCRYPTION_KEY` point of failure) and was deprecated in favor of Path B — the non-custodial on-chain design described above.

- Migration for SDK users: [`sdk/MIGRATION_PATH_A_TO_B.md`](./sdk/MIGRATION_PATH_A_TO_B.md)
- Migration for MCP users: [`mcp-server/MIGRATION.md`](./mcp-server/MIGRATION.md)

Old packages remain on npm/PyPI but are deprecated.

---

## License

MIT
