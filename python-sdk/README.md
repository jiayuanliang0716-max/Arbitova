# arbitova

**Non-custodial USDC escrow for agent-to-agent payments on Base.**

Two agents lock USDC into a contract, one delivers, the other confirms or disputes, and a neutral arbiter resolves. Arbitova never holds the money — the contract does.

No API keys. No registration. No custody. Your Ethereum address is your identity.

```bash
pip install arbitova
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
- **Verdict transparency.** Every arbiter decision, its reasoning, the ensemble vote breakdown, and the content-hash integrity data is published per-case at [arbitova.com/verdicts](https://arbitova.com/verdicts).

**This is not a marketplace.** There is no Arbitova account, no listing fee, no Arbitova Pro tier. The protocol is the whole product.

---

## Dispute publicity

If an escrow is disputed and resolved by Arbitova arbitration, the verdict, reasoning, and ensemble vote breakdown are published per-case at [arbitova.com/verdicts](https://arbitova.com/verdicts). The delivery payload itself is not published (only its keccak256 hash). Your wallet address is already public on-chain. See the [transparency policy](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/docs/transparency-policy.md).

---

## 30-second quickstart

Both sides need a Base Sepolia private key with some test USDC + a pinch of ETH for gas.
Faucet: <https://faucet.circle.com/> (Base Sepolia USDC) · gas: <https://www.alchemy.com/faucets/base-sepolia>

### Buyer

```python
import os
from arbitova import path_b

os.environ["ARBITOVA_RPC_URL"] = "https://sepolia.base.org"
os.environ["ARBITOVA_CHAIN_ID"] = "84532"
os.environ["ARBITOVA_ESCROW_ADDRESS"] = "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC"
os.environ["ARBITOVA_USDC_ADDRESS"] = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
os.environ["ARBITOVA_PRIVATE_KEY"] = "<buyer_private_key>"

result = path_b.arbitova_create_escrow(
    seller_address="0xSellerAddressHere",
    amount_usdc="5.00",
    delivery_hours=24,
    review_hours=24,
    verification_uri="https://example.com/spec.json",
)
print(f"Escrow #{result['escrow_id']} — tx {result['tx_hash']}")
```

### Seller

```python
import os
from arbitova import path_b

os.environ["ARBITOVA_PRIVATE_KEY"] = "<seller_private_key>"
# (other env vars same as buyer)

result = path_b.arbitova_mark_delivered(
    escrow_id=1,
    delivery_payload_uri="https://example.com/receipt.json",
    delivery_content_bytes=b"hello, buyer",  # content-hash pinned on-chain
)
print(f"Delivered — tx {result['tx_hash']}")
```

### Buyer confirms (happy path)

```python
path_b.arbitova_confirm_delivery(escrow_id=1)
# Contract pays seller (amount − 0.5% release fee) atomically.
```

### Or: buyer disputes → Arbitova resolves

```python
path_b.arbitova_dispute(escrow_id=1, reason="Delivery did not match spec section 3.2")
# Arbitova signer runs AI arbitration off-chain, then calls resolve() with the split.
```

---

## API reference (Path B — on-chain)

| Function | Description |
|---|---|
| `arbitova_create_escrow(seller, amount, delivery_hours, review_hours, verification_uri)` | Buyer locks USDC into the escrow contract |
| `arbitova_mark_delivered(escrow_id, delivery_payload_uri, delivery_content_bytes)` | Seller signals delivery + pins `keccak256(delivery_content_bytes)` on-chain |
| `arbitova_confirm_delivery(escrow_id)` | Buyer releases funds; contract pays seller (minus 0.5% release fee) |
| `arbitova_dispute(escrow_id, reason)` | Buyer opens dispute; bond is locked; Arbitova arbiter resolves |
| `arbitova_resolve(escrow_id, buyer_bps, seller_bps, verdict_hash)` | Arbiter-only — posts final split to chain |
| `arbitova_get_escrow(escrow_id)` | Read current state |
| `arbitova_cancel_if_not_delivered(escrow_id)` | Buyer safety valve — reclaim funds after delivery deadline |
| `arbitova_escalate_if_expired(escrow_id)` | Permissionless — anyone can push a silent review window into `DISPUTED` |
| `verify_delivery_hash(delivery_content_bytes, on_chain_delivery_hash)` | Buyer verification: recompute the hash and compare to what's on-chain |

---

## Fees (contract-level)

| On | Rate | Paid by | Source |
|---|---|---|---|
| `confirmDelivery` / `escalateIfExpired` | 0.5% (`releaseFeeBps = 50`) | Seller (deducted from payout) | Contract |
| `resolve` (after dispute) | 2% (`resolveFeeBps = 200`) | Losing party (from their share) | Contract |

No Arbitova balance to top up. No invoices. Fees are collected on-chain in USDC when the contract releases funds.

---

## Links

- Website: <https://arbitova.com>
- Pay UI: <https://arbitova.com/pay>
- Verdicts dashboard: <https://arbitova.com/verdicts>
- Spec (RFC v0.1): <https://github.com/jiayuanliang0716-max/Arbitova/blob/master/spec/A2A-ESCROW-RFC-v0.1.md>
- GitHub: <https://github.com/jiayuanliang0716-max/Arbitova>
- Transparency policy: <https://github.com/jiayuanliang0716-max/Arbitova/blob/master/docs/transparency-policy.md>
- npm (JS SDK): <https://www.npmjs.com/package/@arbitova/sdk>
- MCP server: <https://www.npmjs.com/package/@arbitova/mcp-server>
