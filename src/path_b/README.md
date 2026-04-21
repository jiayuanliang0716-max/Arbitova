# Path B — On-Chain Escrow Off-Chain Infrastructure

Off-chain services for the `EscrowV1` smart contract on Base.
Runs as a **separate process** (separate Render worker service) — never imported by Path A.

## Architecture

```
Base RPC
   │
   ▼
[ indexer.js ] ──── polls events every 10s ────► path_b_escrows
   │                                              path_b_events
   │                                              path_b_indexer_cursor
   │
   ├──► [ notify.js ] ── email (Brevo SMTP) ──► buyer / seller
   │         │          ── webhook POST ───────► agent webhook_url
   │         │
   │         └──► [ arbiter.js ] ── Claude API ──► verdict JSON
   │                   │                            path_b_verdicts/{id}.json
   │                   └── resolve() on-chain ─────► EscrowV1
   │
[ worker.js ] ── every 5 min ── escalateIfExpired() ──► EscrowV1
   │
[ run.js ] ── starts indexer + worker in one process
```

## Env vars (`src/path_b/.env`)

| Variable              | Required | Description                                      |
|-----------------------|----------|--------------------------------------------------|
| `BASE_RPC_URL`        | Yes      | Base JSON-RPC endpoint                           |
| `ESCROW_V1_ADDRESS`   | Yes      | Deployed EscrowV1 contract address               |
| `CHAIN_ID`            | Yes      | 8453 (mainnet) or 84532 (Sepolia)                |
| `START_BLOCK`         | Yes      | Block number of first contract deployment        |
| `PATH_B_SIGNER_KEY`   | Yes      | Private key for escalateIfExpired() calls        |
| `PATH_B_ARBITER_KEY`  | Yes      | Private key for resolve() calls (arbiter role)   |
| `ANTHROPIC_API_KEY`   | Yes      | Claude API key                                   |
| `DATABASE_URL`        | Prod     | Postgres connection string (unset = SQLite dev)  |
| `BREVO_SMTP_KEY`      | Prod     | Brevo SMTP password                              |
| `BREVO_SMTP_NAME`     | Prod     | Brevo SMTP username                              |

## Run locally

```bash
# Apply migrations (SQLite dev)
sqlite3 a2a.db < migrations/path_b/001_escrow_tables.sqlite.sql

# Create src/path_b/.env with required vars (see table above)
cp src/path_b/.env.example src/path_b/.env  # then fill in values

# Run all three services in one process
node src/path_b/run.js

# Or run only the indexer
node src/path_b/indexer.js

# Run tests
node --test src/path_b/__tests__/indexer.test.js
node --test src/path_b/__tests__/notify.test.js
node --test src/path_b/__tests__/arbiter.test.js
```

## Deploy as a separate Render service

Add to `render.yaml`:

```yaml
- type: worker
  name: arbitova-path-b
  env: node
  buildCommand: npm install
  startCommand: node src/path_b/run.js
  envVars:
    - key: DATABASE_URL
      fromDatabase:
        name: <your-db-name>
        property: connectionString
    - key: BASE_RPC_URL
      value: https://mainnet.base.org
    - key: ESCROW_V1_ADDRESS
      value: <deployed address>
    - key: CHAIN_ID
      value: "8453"
    - key: START_BLOCK
      value: "<deployment block>"
    - key: PATH_B_SIGNER_KEY
      sync: false
    - key: PATH_B_ARBITER_KEY
      sync: false
    - key: ANTHROPIC_API_KEY
      sync: false
    - key: BREVO_SMTP_KEY
      sync: false
    - key: BREVO_SMTP_NAME
      sync: false
```

## Path A integration hooks (pending — do not touch Path A yet)

1. **Email collection**: `buyer_email` / `seller_email` on `path_b_escrows` are currently set only
   if passed at creation time. Path A will need to expose an endpoint or UI for users to associate
   their email with a wallet address before escrow creation.

2. **Webhook URL**: currently read from `agents.settings.webhook_url`. If Path A adds a dedicated
   `webhook_url` column to the `agents` table, update `notify.js → getAgentWebhookUrl()`.

3. **Delivery payload URI**: Path A (or the seller's agent) must PUT the delivery payload somewhere
   (IPFS / S3) and call `markDelivered(id, deliveryHash)` on-chain. Path B reads the URI from
   `delivery_payload_uri` — this must be populated before arbitration can fetch evidence.

## No new npm packages added

All dependencies were already in `package.json`:
- `ethers` ^6 — blockchain interaction
- `@anthropic-ai/sdk` — Claude API
- `nodemailer` — email (Brevo)
- `pg` / `better-sqlite3` — database (via Path A helpers)
- `uuid` — primary keys
- `dotenv` — env loading (devDependency)
