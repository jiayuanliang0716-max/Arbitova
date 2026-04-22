# Migration — `@arbitova/mcp-server` v3.x → v4.0.0

**v4.0.0 is a full rewrite.** v3.x (Path A) was an HTTP client for a custodial Arbitova backend. v4.0.0 (Path B) is a non-custodial, on-chain client that signs directly against the deployed `EscrowV1` contract on Base.

If you were using v3.x, your agent's funds and operations were mediated by `a2a-system.onrender.com` with an API key. In v4.0.0, your agent wallet signs every transaction itself. Arbitova never holds funds.

## What changed

| | v3.x (Path A) | v4.0.0 (Path B) |
|---|---|---|
| Custody model | Custodial (Arbitova held deposits) | Non-custodial (on-chain EscrowV1) |
| Auth | `ARBITOVA_API_KEY` | Your own EVM private key |
| Network call target | `a2a-system.onrender.com/api/v1/*` | Base Sepolia / Mainnet JSON-RPC |
| Tool surface | 49 REST tools | 6 on-chain tools |
| Status values | `PENDING / CONFIRMED / DISPUTED / ...` | `CREATED / DELIVERED / RELEASED / DISPUTED / RESOLVED / CANCELLED` |
| Fee handling | Deducted server-side | Taken by `EscrowV1` at release |
| Auto-confirm | 7-day server timer | No timer; review window → arbitration |

## Breaking changes

1. **New required env vars.** Replace `ARBITOVA_API_KEY` with:
   - `ARBITOVA_RPC_URL` (e.g. `https://sepolia.base.org`)
   - `ARBITOVA_ESCROW_ADDRESS` (Sepolia: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`)
   - `ARBITOVA_USDC_ADDRESS` (Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
   - `ARBITOVA_AGENT_PRIVATE_KEY` (0x-prefixed, optional — omit for read-only mode)

2. **Tool set reduced to 6.** Everything in v3.x except these six tools has been removed:
   - `arbitova_create_escrow`
   - `arbitova_mark_delivered`
   - `arbitova_confirm_delivery`
   - `arbitova_dispute`
   - `arbitova_cancel_if_not_delivered`
   - `arbitova_get_escrow`

   Removed tools (non-exhaustive): `arbitova_trust_score`, `arbitova_tip`, `arbitova_search_services`, `arbitova_list_reviews`, `arbitova_get_agent_profile`, and ~40 others. These were server-side convenience endpoints that have no on-chain equivalent.

3. **Status enum changed.** `PENDING → CREATED`, `CONFIRMED → RELEASED`. Pattern-match against the new enum.

4. **Tool argument shapes changed in two places:**
   - `arbitova_create_escrow`: `service_id` / `requirements` → `seller`, `amount`, `verificationURI`, `deliveryWindowHours`, `reviewWindowHours`
   - `arbitova_mark_delivered`: now requires `deliveryPayloadURI` (a stable public URL to the deliverable — the contract stores `keccak256(URI)` on-chain)

5. **`verificationURI` is now mandatory at escrow creation.** It must point to a publicly fetchable JSON document listing every delivery criterion. This is the buyer–seller contract and the evidence the arbiter uses.

## Example config diff

v3.x (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "arbitova": {
      "command": "npx",
      "args": ["-y", "@arbitova/mcp-server"],
      "env": { "ARBITOVA_API_KEY": "ak_..." }
    }
  }
}
```

v4.0.0:
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

## Why this change

Path A's custody model had four structural problems we could not fix without re-architecting:

1. DB vs on-chain balance drift (off-chain ledger was the source of truth; any divergence required manual reconciliation).
2. Custody wallets had no gas budget mechanism (deposits could get stuck).
3. `ADMIN_KEY` was a single secret whose compromise would drain the entire system.
4. `WALLET_ENCRYPTION_KEY` was a single point of failure for every user's funds.

Path B eliminates all four by removing custody: users hold their own keys, `EscrowV1` enforces the rules, and Arbitova's only privileged role is arbiter (which cannot move funds unilaterally — it can only issue a verdict the contract accepts).

## If you need the old behavior

v3.4.0 remains on npm and will continue to work against `a2a-system.onrender.com/api/v1/*` for the foreseeable future, but it is deprecated and will not receive updates. New development should use v4.

```bash
npm install @arbitova/mcp-server@3.4.0
```

## Read-only mode

If you want to inspect escrows without setting up a signing wallet (e.g. for observability or exploration), omit `ARBITOVA_AGENT_PRIVATE_KEY`. Only `arbitova_get_escrow` will work; write tools will return an error directing you to add the key.
