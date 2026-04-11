# Arbitova — Technical Blueprint

> **Arbitova: Trust infrastructure for the Agent economy.**

Version 2.0 | April 2026

---

## Part 1: Vision & Positioning

### One-line definition

Arbitova is the escrow, verification, and arbitration layer that lets any AI agent pay any other AI agent — with programmable trust guarantees.

### What Arbitova IS

- An **API and SDK** that agent frameworks (LangChain, CrewAI, AutoGen, custom) embed to handle payments between agents.
- A **programmable escrow engine** — funds lock on task creation, release on verified delivery, refund on failure. No human in the loop unless needed.
- An **auto-verification system** — delivery outputs are validated against JSON Schema contracts and rule sets before funds move.
- An **AI arbitrator** — when buyer and seller agents disagree, Claude adjudicates the dispute using the contract, delivery evidence, and order context.
- A **reputation/credit scoring layer** — every completed transaction, every dispute outcome, every verification pass/fail feeds a public score that agents can query before transacting.

### What Arbitova is NOT

| Arbitova is NOT...          | Why                                                                                          |
|----------------------------|----------------------------------------------------------------------------------------------|
| A marketplace              | We don't match buyers and sellers. Agent frameworks handle discovery. We handle the money.    |
| A wallet                   | We custody funds in escrow during transactions. Agents fund accounts via USDC or fiat top-up. |
| PayPal / Venmo for AI      | Those are simple money transfers. We are escrow + verification + arbitration.                 |
| A blockchain protocol      | We use crypto (Base L2 / USDC) as one funding rail, not as the product itself.               |
| An agent framework         | We don't orchestrate agent workflows. We settle them financially.                            |

### Why it exists

The Agent economy has a **trust gap**. When Agent A hires Agent B to summarize 500 documents:

1. **Who holds the money?** Agent A won't pay upfront (Agent B might not deliver). Agent B won't work for free (Agent A might not pay). **Answer: Escrow.**
2. **How do you know the work is done?** A human can't review 500 summaries. **Answer: Auto-verification against a schema contract.**
3. **What happens when things go wrong?** Agents can't negotiate. **Answer: AI arbitration with stake slashing.**
4. **How do you pick a reliable agent?** No track record exists. **Answer: On-chain reputation scores.**

No existing payment infrastructure solves all four. Stripe handles money movement but has no concept of delivery verification. PayPal has buyer protection but requires human review. Coinbase Agent Kit handles crypto wallets but has no escrow logic.

### Competitive positioning

| Capability              | Stripe    | PayPal    | Coinbase Agent Kit | **Arbitova**         |
|------------------------|-----------|-----------|--------------------|---------------------|
| Agent-native API/SDK   | No        | No        | Partial            | **Yes**             |
| Programmatic escrow    | No        | No        | No                 | **Yes**             |
| Auto-verification      | No        | No        | No                 | **Yes**             |
| AI arbitration         | No        | Manual    | No                 | **Yes**             |
| Reputation scoring     | No        | Seller ratings | No            | **Yes (per-agent)** |
| Fiat funding           | Yes       | Yes       | No                 | **Yes (via LSQ)**   |
| Crypto funding (USDC)  | Limited   | No        | Yes                | **Yes (Base L2)**   |
| Sub-delegation         | No        | No        | No                 | **Yes**             |
| Webhook callbacks      | Yes       | Yes       | No                 | **Yes (new)**       |

---

## Part 2: System Architecture

### Architecture diagram

```
                          +---------------------------------------------+
                          |          AGENT FRAMEWORKS                    |
                          |  LangChain  |  CrewAI  |  AutoGen  |  ...  |
                          +------+------+----+-----+-----+-----+-------+
                                 |           |           |
                          +------v-----------v-----------v-----------+
                          |           @arbitova/sdk (npm)             |
                          |           arbitova (PyPI)                 |
                          |                                          |
                          |  pay() escrow() verify() arbitrate()     |
                          |  getReputation() onStatusChange()        |
                          +------------------+-----------------------+
                                             | HTTPS + X-API-Key
                                             v
+----------------------------------------------------------------------------+
|                         A2A PAY REST API (Express 5)                       |
|                                                                            |
|  +----------+  +--------------+  +-----------+  +----------+              |
|  | Identity |  | Transactions |  |  Verify   |  | Disputes |              |
|  |          |  |              |  |           |  |          |              |
|  | register |  | create order |  | JSON      |  | open     |              |
|  | api keys |  | deliver      |  |  Schema   |  | AI arb   |              |
|  | profile  |  | confirm      |  | Rules     |  | resolve  |              |
|  | stake    |  | bundle       |  | engine    |  | slash    |              |
|  +----+-----+  | subdelegate  |  +-----+-----+  +----+-----+              |
|       |        +------+-------+        |              |                    |
|  +----v--------------v----------------v--------------v---------------+    |
|  |                    CORE ENGINE                                    |    |
|  |                                                                   |    |
|  |  Escrow Manager ---- Balance ledger ---- Fee calculator           |    |
|  |  Reputation Engine -- Score + History -- Stake/Slash              |    |
|  |  Verification Engine - AJV schemas ---- Custom rules              |    |
|  |  Arbitration Engine -- Claude Haiku ---- Evidence assembly        |    |
|  |  Webhook Dispatcher -- Status callbacks - Retry queue             |    |
|  +--------+-----------------+-------------------+--------------------+    |
|           |                 |                   |                         |
|  +--------v------+  +------v--------+  +-------v--------+               |
|  |  PostgreSQL   |  |  Base L2 /    |  | LemonSqueezy   |               |
|  |  (primary)    |  |  USDC on-chain|  | (fiat gateway) |               |
|  |               |  |               |  |                |               |
|  |  SQLite       |  |  Alchemy RPC  |  | Checkout +     |               |
|  |  (dev mode)   |  |  ethers.js    |  | Webhooks       |               |
|  +---------------+  +---------------+  +----------------+               |
|                                                                          |
|                    +--------------------+                                 |
|                    | Developer Dashboard|                                 |
|                    | (SPA -- public/)   |                                 |
|                    +--------------------+                                 |
+--------------------------------------------------------------------------+
```

### Tech stack (current -- minimal changes)

| Layer              | Technology                 | File(s)                              |
|--------------------|----------------------------|--------------------------------------|
| Runtime            | Node.js (CommonJS)         | `package.json`                       |
| HTTP framework     | Express 5.2               | `src/server.js`                      |
| Database (prod)    | PostgreSQL via `pg`        | `src/db/schema.js`                   |
| Database (dev)     | SQLite via `better-sqlite3`| `src/db/schema.js`                   |
| Verification       | AJV 8 (JSON Schema)       | `src/verify.js`                      |
| AI arbitration     | Anthropic SDK (Haiku)      | `src/arbitrate.js`                   |
| Crypto             | ethers.js 6 (Base L2)     | `src/wallet.js`                      |
| Fiat payments      | LemonSqueezy              | `src/routes/payments.js`             |
| Auth               | API key in X-API-Key header| `src/middleware/auth.js`             |
| Rate limiting      | express-rate-limit         | `src/server.js`                      |
| API docs           | Swagger UI + OpenAPI JSON  | `src/openapi.json`                   |
| Scheduling         | node-cron                  | `src/server.js` (billing + expiry)   |

### What changes from the current architecture

| Change                            | Effort  | Details                                                                                    |
|-----------------------------------|---------|--------------------------------------------------------------------------------------------|
| Add SDK layer (`@arbitova/sdk`)    | Medium  | New npm package wrapping REST API. No backend changes.                                     |
| Add Python SDK (`arbitova`)        | Medium  | Thin wrapper using `httpx`. No backend changes.                                            |
| Add webhook outbound system       | Medium  | New table `webhooks`, new module `src/webhooks.js`. POST to registered URLs on status change. |
| Add `/api/v1/` prefix            | Small   | Namespace all API endpoints under `/api/v1/`. Keep old routes as aliases during migration.  |
| Remove marketplace frontend       | Small   | Replace `public/` SPA with developer dashboard (balance, API keys, docs, tx history).       |
| Remove `services` as public browse| Small   | Services become private contracts between agents, not browseable listings.                   |
| Add `webhooks` table              | Small   | Schema migration in `src/db/schema.js`.                                                    |
| Add `api_keys` table              | Small   | Support multiple keys per agent with scopes (read/write/admin).                             |
| Rename branding                   | Trivial | "Arbitova" references become "Arbitova" in server logs, health check, docs.               |

**What stays the same**: The entire escrow flow (`orders.js`), verification engine (`verify.js`), arbitration engine (`arbitrate.js`), reputation system (`agents.js:adjustReputation`), database schema pattern, auth middleware, deployment target (Render). The pivot is a **repositioning**, not a rewrite.

---

## Part 3: API Specification

All endpoints under `/api/v1/`. Authentication via `X-API-Key` header unless marked `[public]` or `[admin]`.

### 3.1 Identity

| Method | Endpoint                        | Description                                         | Source file              |
|--------|---------------------------------|-----------------------------------------------------|--------------------------|
| POST   | `/agents/register`              | Register a new agent. Returns `id`, `api_key`, `wallet_address`. | `src/routes/agents.js:14`  |
| GET    | `/agents/:id`                   | Get agent profile (balance, escrow, stake, reputation). | `src/routes/agents.js:136` |
| POST   | `/agents/:id/rotate-key`        | Rotate API key. Invalidates previous key.           | `src/routes/agents.js:202` |
| POST   | `/agents/stake`                 | Lock balance as trust bond (stake).                 | `src/routes/agents.js:164` |
| POST   | `/agents/unstake`               | Release stake back to balance.                      | `src/routes/agents.js:183` |
| GET    | `/agents/:id/wallet`            | Wallet address + on-chain USDC balance.             | `src/routes/agents.js:246` |
| POST   | `/agents/:id/sync-balance`      | Detect on-chain USDC deposits, credit to balance.   | `src/routes/agents.js:212` |
| POST   | `/agents/topup`                 | Add test funds (mock mode only).                    | `src/routes/agents.js:268` |

### 3.2 Contracts (formerly "Services")

Services define the contract terms for a transaction. In Arbitova, services are **private contracts** -- not public marketplace listings.

| Method | Endpoint                        | Description                                          | Source file               |
|--------|---------------------------------|------------------------------------------------------|---------------------------|
| POST   | `/services`                     | Create a service contract with price, schemas, rules.| `src/routes/services.js`  |
| GET    | `/services/:id`                 | Get contract details.                                | `src/routes/services.js`  |
| PUT    | `/services/:id`                 | Update contract terms.                               | `src/routes/services.js`  |
| GET    | `/agents/:id/services`          | List contracts owned by an agent.                    | `src/routes/agents.js:101`|

**Marketplace browse endpoints** (`GET /services` with filters) become **optional/deprecated**. Agent frameworks handle discovery; Arbitova handles settlement.

### 3.3 Transactions

| Method | Endpoint                         | Description                                               | Source file               |
|--------|----------------------------------|-----------------------------------------------------------|---------------------------|
| POST   | `/orders`                        | Create escrow transaction. Locks buyer funds.             | `src/routes/orders.js:28` |
| GET    | `/orders/:id`                    | Get transaction details + delivery status.                | `src/routes/orders.js:218`|
| POST   | `/orders/:id/deliver`            | Seller submits deliverable. Triggers auto-verification.   | `src/routes/orders.js:239`|
| POST   | `/orders/:id/confirm`            | Buyer confirms. Releases escrow to seller (minus 2.5% fee).| `src/routes/orders.js:329`|
| POST   | `/orders/bundle`                 | Atomic multi-order creation (up to 20).                   | `src/routes/orders.js:121`|
| GET    | `/orders/bundle/:id`             | Bundle status + child orders.                             | `src/routes/orders.js:198`|
| POST   | `/orders/:id/subdelegate`        | Seller sub-contracts work to another agent.               | `src/routes/orders.js:464`|
| GET    | `/orders/:id/subdelegations`     | List sub-orders for a parent order.                       | `src/routes/orders.js:529`|
| GET    | `/agents/:id/orders`             | List all orders for an agent (as buyer or seller).        | `src/routes/agents.js:117`|

### 3.4 Verification

Verification is embedded in the transaction flow, not a standalone endpoint. The logic lives in `src/verify.js`.

| Function            | Trigger                                    | Behavior                                                     |
|---------------------|--------------------------------------------|--------------------------------------------------------------|
| `verifyInput()`     | `POST /orders` -- when `input_schema` exists on service | Validates buyer's `requirements` against JSON Schema. Rejects order if invalid. |
| `verifyDelivery()`  | `POST /orders/:id/deliver` -- when `output_schema` or `verification_rules` exist | Validates delivery `content` against schema + rules. If `auto_verify=true` and passes, auto-completes and releases escrow. If fails, auto-refunds buyer and penalizes seller reputation by 20 points. |

**Verification rule types** (defined in `src/verify.js:runRules`):
- `required` -- field must exist and be non-empty
- `min_length` / `max_length` -- string length bounds
- `contains` -- substring match (optional `ignore_case`)
- `regex` -- regex pattern match
- `equals` -- exact value match
- `min_items` -- minimum array length

### 3.5 Disputes & Arbitration

| Method | Endpoint                          | Description                                              | Source file               |
|--------|-----------------------------------|----------------------------------------------------------|---------------------------|
| POST   | `/orders/:id/dispute`             | Open a dispute. Locks funds in escrow. Status changes to `disputed`. | `src/routes/orders.js:360`|
| POST   | `/orders/:id/auto-arbitrate`      | Trigger AI arbitration (Claude Haiku). Resolves dispute automatically. | `src/routes/orders.js:553`|
| POST   | `/orders/:id/resolve-dispute`     | `[admin]` Manual resolution. `X-Admin-Key` required.     | `src/routes/orders.js:393`|

**AI arbitration flow** (implemented in `src/arbitrate.js:arbitrateDispute`):
1. Assembles context: order details, service contract (including schemas), dispute reason + evidence, delivery content (truncated to 2000 chars).
2. Prompts Claude Haiku to return `{ winner, reasoning, confidence }`.
3. Executes verdict: refund buyer OR pay seller (minus 2.5% fee).
4. Penalizes loser's reputation by 20 points.
5. Slashes loser's stake (up to order amount) and credits winner.

### 3.6 Reputation

| Method | Endpoint                          | Description                                              | Source file               |
|--------|-----------------------------------|----------------------------------------------------------|---------------------------|
| GET    | `/agents/:id/reputation` `[public]`| Get reputation score + history (last 50 events).        | `src/routes/agents.js:80` |
| GET    | `/agents/leaderboard` `[public]`  | Top agents by reputation score.                          | `src/routes/agents.js:60` |

**Reputation scoring** (implemented in `src/routes/orders.js:adjustReputation`):

| Event                        | Delta  | Stored reason                  |
|------------------------------|--------|--------------------------------|
| Order completed (confirmed)  | +10    | `order_completed`              |
| Auto-verified completion     | +10    | `auto_verified_completion`     |
| Auto-verification failed     | -20    | `auto_verification_failed`     |
| Dispute lost                 | -20    | `dispute_lost`                 |

### 3.7 Funding

| Method | Endpoint                          | Description                                              | Source file               |
|--------|-----------------------------------|----------------------------------------------------------|---------------------------|
| POST   | `/agents/:id/sync-balance`        | Detect on-chain USDC deposits, credit to balance.        | `src/routes/agents.js:212`|
| POST   | `/payments`                       | Initiate fiat payment via LemonSqueezy checkout.         | `src/routes/payments.js`  |
| POST   | `/withdrawals`                    | Withdraw balance to external USDC address.               | `src/routes/withdrawals.js`|
| POST   | `/webhook/lemonsqueezy`           | `[public]` Inbound webhook from LemonSqueezy.            | `src/webhook.js`          |

### 3.8 New endpoints (to be built)

| Method | Endpoint                          | Description                                              | Priority |
|--------|-----------------------------------|----------------------------------------------------------|----------|
| POST   | `/webhooks`                       | Register a webhook URL for status callbacks.             | P0       |
| GET    | `/webhooks`                       | List registered webhooks.                                | P0       |
| DELETE | `/webhooks/:id`                   | Remove a webhook.                                        | P0       |
| POST   | `/api-keys`                       | Create additional API keys with scopes.                  | P1       |
| GET    | `/api-keys`                       | List active API keys (masked).                           | P1       |
| DELETE | `/api-keys/:id`                   | Revoke an API key.                                       | P1       |
| GET    | `/transactions/:id/timeline`      | Full event timeline for a transaction (created, escrowed, delivered, verified, completed). | P1 |

**Webhook payload format** (outbound):

```json
{
  "event": "transaction.completed",
  "transaction_id": "uuid",
  "timestamp": "2026-04-10T12:00:00Z",
  "data": {
    "status": "completed",
    "amount": 25.00,
    "buyer_id": "uuid",
    "seller_id": "uuid",
    "verification": { "passed": true, "auto_verified": true },
    "platform_fee": 0.625,
    "seller_received": 24.375
  }
}
```

**Event types**: `transaction.created`, `transaction.delivered`, `transaction.completed`, `transaction.refunded`, `transaction.disputed`, `dispute.resolved`, `verification.failed`, `verification.passed`.

---

## Part 4: SDK Specification

### 4.1 Node.js SDK -- `@arbitova/sdk`

**Install**: `npm install @arbitova/sdk`

```javascript
const { Arbitova } = require('@arbitova/sdk');

const client = new Arbitova({
  apiKey: 'your-api-key',
  baseUrl: 'https://api.arbitova.com/api/v1', // default
});
```

#### Core methods

```javascript
// --- Escrow: create a transaction with funds locked ---
const tx = await client.escrow({
  serviceId: 'service-uuid',        // the contract to execute
  requirements: { topic: 'AI' },    // validated against service.input_schema
});
// Returns: { id, status: 'paid', amount, deadline, escrow_locked: true }

// --- Pay: shorthand for escrow + auto-confirm on delivery ---
const tx = await client.pay({
  serviceId: 'service-uuid',
  requirements: { topic: 'AI' },
  autoConfirm: true,                // auto-confirm after delivery passes verification
});

// --- Deliver: seller submits work product ---
const result = await client.deliver(tx.id, {
  content: JSON.stringify({ summary: '...', tags: ['ai', 'ml'] }),
});
// Returns: { status: 'completed', auto_verified: true, seller_received: 24.375 }

// --- Verify: check delivery without submitting (dry run) ---
const check = await client.verify(serviceId, content);
// Returns: { ok: true/false, stage: 'output_schema'|'rules'|null, errors: [] }

// --- Arbitrate: trigger AI dispute resolution ---
const verdict = await client.arbitrate(tx.id, {
  reason: 'Delivery incomplete',
  evidence: 'Missing 3 of 5 required sections',
});
// Returns: { winner: 'buyer', reasoning: '...', confidence: 0.92 }

// --- Reputation: check agent trust score ---
const rep = await client.getReputation(agentId);
// Returns: { reputation_score: 180, history: [...] }

// --- Webhooks: register status callbacks ---
await client.webhooks.create({
  url: 'https://my-agent.com/callback',
  events: ['transaction.completed', 'transaction.disputed'],
});

// --- Events: listen for status changes (polling-based) ---
client.on('transaction.completed', (event) => {
  console.log(`Transaction ${event.transaction_id} completed`);
});
```

#### Constructor options

```javascript
new Arbitova({
  apiKey: string,                    // required
  baseUrl: string,                   // default: 'https://api.arbitova.com/api/v1'
  timeout: number,                   // request timeout in ms, default: 30000
  retries: number,                   // auto-retry on 5xx, default: 2
  webhookSecret: string,             // for verifying inbound webhook signatures
});
```

### 4.2 Python SDK -- `arbitova`

**Install**: `pip install arbitova`

```python
from a2a_pay import Arbitova

client = Arbitova(api_key="your-api-key")

# Escrow a transaction
tx = client.escrow(
    service_id="service-uuid",
    requirements={"topic": "AI"},
)

# Deliver
result = client.deliver(tx.id, content={"summary": "...", "tags": ["ai"]})

# Check reputation
rep = client.get_reputation(agent_id="agent-uuid")
```

### 4.3 LangChain Tool Integration

```python
from langchain.tools import Tool
from a2a_pay import Arbitova

pay_client = Arbitova(api_key="sk-...")

a2a_pay_tool = Tool(
    name="a2a_pay",
    description=(
        "Pay another AI agent to perform a task. "
        "Input: JSON with 'service_id' and 'requirements'. "
        "Funds are held in escrow until delivery is verified."
    ),
    func=lambda input: pay_client.pay(
        service_id=input["service_id"],
        requirements=input["requirements"],
        auto_confirm=True,
    ),
)

a2a_reputation_tool = Tool(
    name="a2a_check_reputation",
    description="Check the trust score of an AI agent before transacting.",
    func=lambda agent_id: pay_client.get_reputation(agent_id),
)

# Use in an agent
from langchain.agents import initialize_agent, AgentType
from langchain_anthropic import ChatAnthropic

llm = ChatAnthropic(model="claude-sonnet-4-20250514")
agent = initialize_agent(
    tools=[a2a_pay_tool, a2a_reputation_tool],
    llm=llm,
    agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION,
)

agent.run("Hire an agent to summarize these 100 papers. Check their reputation first.")
```

### 4.4 CrewAI Tool Integration

```python
from crewai.tools import BaseTool
from a2a_pay import Arbitova

pay_client = Arbitova(api_key="sk-...")

class ArbitovaTool(BaseTool):
    name: str = "Arbitova"
    description: str = (
        "Pay another AI agent to perform a task with escrow protection. "
        "Funds are locked until delivery passes automated verification."
    )

    def _run(self, service_id: str, requirements: dict) -> dict:
        tx = pay_client.escrow(
            service_id=service_id,
            requirements=requirements,
        )
        # Wait for delivery (polling)
        import time
        for _ in range(60):
            status = pay_client.get_transaction(tx.id)
            if status["status"] in ("completed", "refunded"):
                return status
            time.sleep(10)
        # Timeout -- open dispute
        return pay_client.arbitrate(tx.id, reason="Delivery timeout")


class A2AReputationTool(BaseTool):
    name: str = "Check Agent Reputation"
    description: str = "Look up the trust score and transaction history of an AI agent."

    def _run(self, agent_id: str) -> dict:
        return pay_client.get_reputation(agent_id)
```

---

## Part 5: Developer Dashboard UI Specification

### 5.1 Landing Page (Stripe-style)

```
+---------------------------------------------------------------------+
|  +---------+                                                        |
|  | Arbitova |   Docs    Pricing    Dashboard              Login      |
|  +---------+                                                        |
+---------------------------------------------------------------------+
|                                                                      |
|       Trust infrastructure                                           |
|       for the Agent economy                                          |
|                                                                      |
|       Escrow. Auto-verification. AI arbitration.                     |
|       One SDK for agent-to-agent payments.                           |
|                                                                      |
|       +--------------------+    +---------------------+             |
|       |  Get API Key ->    |    |  Read the Docs ->   |             |
|       +--------------------+    +---------------------+             |
|                                                                      |
|  +-------------------------------------------------------------+    |
|  |  // Pay another agent with 3 lines of code                  |    |
|  |                                                              |    |
|  |  const { Arbitova } = require('@arbitova/sdk');                |    |
|  |  const client = new Arbitova({ apiKey: 'sk-...' });           |    |
|  |                                                              |    |
|  |  const tx = await client.pay({                              |    |
|  |    serviceId: 'summarize-docs-v2',                          |    |
|  |    requirements: { urls: [...], format: 'markdown' },       |    |
|  |    autoConfirm: true,  // release on verified delivery      |    |
|  |  });                                                         |    |
|  |  // tx.status === 'completed' -- funds released             |    |
|  +-------------------------------------------------------------+    |
|                                                                      |
+----------------------------------------------------------------------+
|                                                                      |
|  +-------------+  +--------------+  +--------------+                |
|  |   ESCROW    |  |   VERIFY     |  |  ARBITRATE   |                |
|  |             |  |              |  |              |                |
|  | Funds lock  |  | JSON Schema  |  | AI resolves  |                |
|  | on order.   |  | + rules      |  | disputes in  |                |
|  | Release on  |  | validate     |  | < 30 seconds |                |
|  | delivery.   |  | delivery     |  | with stake   |                |
|  |             |  | auto.        |  | slashing.    |                |
|  +-------------+  +--------------+  +--------------+                |
|                                                                      |
|  +-------------+  +--------------+  +--------------+                |
|  | REPUTATION  |  |  SUB-TASKS   |  |  WEBHOOKS    |                |
|  |             |  |              |  |              |                |
|  | Credit      |  | Agents can   |  | Real-time    |                |
|  | scores for  |  | subcontract  |  | callbacks    |                |
|  | every agent |  | to other     |  | on every     |                |
|  | built from  |  | agents.      |  | status       |                |
|  | tx history. |  | Chain escrow.|  | change.      |                |
|  +-------------+  +--------------+  +--------------+                |
|                                                                      |
+----------------------------------------------------------------------+
|  "Arbitova is like Stripe, but for AI agents.                        |
|   It handles the part humans can't -- verifying                     |
|   that one AI actually did what another AI paid for."               |
|                                                                      |
|                    +----------------------+                          |
|                    |  Start Building ->   |                          |
|                    +----------------------+                          |
|                                                                      |
|  ---------------------------------------------------------------    |
|  Arbitova  |  Docs  |  GitHub  |  Status       (c) 2026 Arbitova     |
+----------------------------------------------------------------------+
```

### 5.2 Developer Dashboard

```
+---------------------------------------------------------------------+
|  Arbitova    Dashboard    Transactions    Docs    Settings            |
+-----------+---------------------------------------------------------+
|           |                                                          |
|  Overview |   BALANCE          ESCROW LOCKED      REPUTATION         |
|           |   +----------+    +--------------+   +------------+     |
|  Transac- |   | 1,247.50 |    |    350.00    |   |    +180     |    |
|  tions    |   |   USDC   |    |     USDC     |   |   score     |    |
|           |   +----------+    +--------------+   +------------+     |
|  API Keys |                                                          |
|           |   TRANSACTION VOLUME (30 days)                           |
|  Webhooks |   +-------------------------------------------------+   |
|           |   |  ......####..####..####..####..####              |   |
|  Contracts|   |  $2,400 total  |  47 completed  |  2 disputed   |   |
|           |   +-------------------------------------------------+   |
|  Settings |                                                          |
|           |   RECENT TRANSACTIONS                                    |
|           |   +-------------------------------------------------+   |
|           |   | ID       | Type | Amount | Status    | Time      |   |
|           |   |----------|------|--------|-----------|-----------|   |
|           |   | tx_a1b2  | BUY  | 25.00  | completed | 2m ago    |   |
|           |   | tx_c3d4  | SELL | 50.00  | delivered | 15m ago   |   |
|           |   | tx_e5f6  | BUY  | 10.00  | disputed  | 1h ago    |   |
|           |   | tx_g7h8  | SELL | 75.00  | escrowed  | 2h ago    |   |
|           |   +-------------------------------------------------+   |
|           |                                                          |
+-----------+---------------------------------------------------------+
|           |                                                          |
|  API Keys |   YOUR API KEYS                                         |
|  (active) |   +-------------------------------------------------+   |
|           |   | Name        | Key            | Scope  | Created  |   |
|           |   |-------------|----------------|--------|----------|   |
|           |   | Production  | sk-****-a1b2   | full   | Mar 15   |   |
|           |   | Read-only   | sk-****-c3d4   | read   | Apr 01   |   |
|           |   +-------------------------------------------------+   |
|           |                                                          |
|           |   +-----------------------+                              |
|           |   |  + Create New Key     |                              |
|           |   +-----------------------+                              |
|           |                                                          |
|           |   Quick Start (curl):                                    |
|           |   +-------------------------------------------------+   |
|           |   | curl -X POST https://api.arbitova.com/api/v1/     |   |
|           |   |   orders -H "X-API-Key: sk-****-a1b2"            |   |
|           |   |   -d '{"service_id":"...","requirements":{}}'    |   |
|           |   +-------------------------------------------------+   |
|           |                                                          |
+-----------+---------------------------------------------------------+
```

### 5.3 Design system

| Property            | Value                                                  |
|---------------------|--------------------------------------------------------|
| Theme               | Dark mode primary. Light mode toggle available.        |
| Background          | `#0a0a0a` (near-black)                                 |
| Surface             | `#1a1a1a` (cards, inputs)                              |
| Border              | `#2a2a2a` (subtle dividers)                            |
| Text primary        | `#fafafa`                                              |
| Text secondary      | `#888888`                                              |
| Accent              | `#00d4aa` (teal-green -- trust/money connotation)      |
| Error               | `#ff4444`                                              |
| Warning             | `#ffaa00`                                              |
| Success             | `#00cc66`                                              |
| Font -- headings    | Inter, system-ui, -apple-system                        |
| Font -- code        | JetBrains Mono, SF Mono, monospace                     |
| Border radius       | 8px (cards), 6px (buttons), 4px (inputs)               |
| Code blocks         | Syntax-highlighted, one-click copy, dark bg `#111111`  |
| Animations          | Minimal. Fade-in on load. No bouncing/sliding.         |
| Responsive          | Mobile-friendly but desktop-first (developer audience).|

---

## Part 6: Database Schema

### 6.1 Current tables (documented)

All tables are defined in `src/db/schema.js`. Dual-mode: PostgreSQL (production) and SQLite (development).

#### `agents` -- Registered agent identities

| Column                | Type         | Description                                      |
|-----------------------|-------------|--------------------------------------------------|
| `id`                  | TEXT PK      | UUID                                             |
| `name`                | TEXT NOT NULL | Display name (max 100 chars)                    |
| `description`         | TEXT         | Agent description (max 1000 chars)               |
| `api_key`             | TEXT UNIQUE  | Authentication key (UUID format)                 |
| `owner_email`         | TEXT         | Optional owner contact                           |
| `balance`             | NUMERIC      | Available balance (default 100 mock, 0 chain)    |
| `escrow`              | NUMERIC      | Funds locked in active transactions              |
| `stake`               | NUMERIC      | Trust bond locked by agent                       |
| `reputation_score`    | INTEGER      | Cumulative reputation score (default 0)          |
| `wallet_address`      | TEXT         | Base L2 USDC wallet address                      |
| `wallet_encrypted_key`| TEXT         | Encrypted private key (AES via WALLET_ENCRYPTION_KEY) |
| `created_at`          | TIMESTAMPTZ  | Registration timestamp                           |

#### `services` -- Transaction contracts

| Column                | Type          | Description                                     |
|-----------------------|--------------|--------------------------------------------------|
| `id`                  | TEXT PK       | UUID                                            |
| `agent_id`            | TEXT FK->agents| Owner agent                                    |
| `name`                | TEXT NOT NULL  | Contract name                                  |
| `description`         | TEXT          | What the service delivers                        |
| `price`               | NUMERIC       | Price in USDC                                   |
| `delivery_hours`      | INTEGER       | Deadline window (default 24)                    |
| `is_active`           | BOOLEAN       | Whether contract is available                   |
| `input_schema`        | JSONB         | JSON Schema for buyer requirements              |
| `output_schema`       | JSONB         | JSON Schema for delivery validation             |
| `verification_rules`  | JSONB         | Array of rule objects (see `src/verify.js`)     |
| `auto_verify`         | BOOLEAN       | Auto-complete on verification pass              |
| `min_seller_stake`    | NUMERIC       | Minimum stake seller must hold                  |
| `sub_price`           | NUMERIC       | Subscription price (optional)                   |
| `sub_interval`        | TEXT          | `daily` / `weekly` / `monthly`                  |
| `file_id`             | TEXT FK->files| Attached digital product file                   |
| `market_type`         | TEXT          | `h2a` / `a2a` (deprecated -- remove)           |
| `product_type`        | TEXT          | `ai_generated` / `digital` / `subscription`    |
| `created_at`          | TIMESTAMPTZ   | Creation timestamp                              |

#### `orders` -- Escrow transactions

| Column                | Type          | Description                                     |
|-----------------------|--------------|--------------------------------------------------|
| `id`                  | TEXT PK       | UUID                                            |
| `buyer_id`            | TEXT FK->agents| Paying agent                                   |
| `seller_id`           | TEXT FK->agents| Delivering agent                               |
| `service_id`          | TEXT FK->services | Contract being executed                      |
| `status`              | TEXT          | `paid` -> `delivered` -> `completed` / `disputed` -> `refunded` |
| `amount`              | NUMERIC       | Escrowed amount                                 |
| `requirements`        | TEXT          | Buyer requirements (JSON string)                |
| `bundle_id`           | TEXT          | Parent bundle ID (atomic multi-order)           |
| `parent_order_id`     | TEXT          | Parent order for sub-delegations                |
| `subscription_id`     | TEXT          | Link to subscription if recurring               |
| `deadline`            | TIMESTAMPTZ   | Auto-refund if not delivered by this time        |
| `created_at`          | TIMESTAMPTZ   | Order creation timestamp                        |
| `completed_at`        | TIMESTAMPTZ   | Completion/refund timestamp                     |

**Order state machine**:
```
                          +------------ dispute -----------+
                          v                                |
 created -> paid -> delivered -> completed        disputed -> resolved
                     |                                      |
                     +-- auto-verify fail -> refunded <-----+
                     |
                     +-- deadline expired -> refunded
```

#### `deliveries` -- Submitted work products

| Column     | Type          | Description            |
|-----------|--------------|------------------------|
| `id`       | TEXT PK       | UUID                  |
| `order_id` | TEXT FK->orders| Parent transaction   |
| `content`  | TEXT          | Delivery payload (JSON string or text) |
| `delivered_at` | TIMESTAMPTZ | Submission timestamp |

#### `disputes` -- Open and resolved disputes

| Column      | Type          | Description                  |
|------------|--------------|-------------------------------|
| `id`        | TEXT PK       | UUID                         |
| `order_id`  | TEXT FK->orders| Disputed transaction        |
| `raised_by` | TEXT FK->agents| Who opened the dispute      |
| `reason`    | TEXT          | Dispute reason               |
| `evidence`  | TEXT          | Supporting evidence          |
| `status`    | TEXT          | `open` / `resolved`         |
| `resolution`| TEXT          | Resolution explanation       |
| `created_at`| TIMESTAMPTZ   | When dispute was opened      |
| `resolved_at`| TIMESTAMPTZ  | When dispute was resolved    |

#### `reputation_history` -- Audit trail for score changes

| Column     | Type          | Description                |
|-----------|--------------|----------------------------|
| `id`       | SERIAL PK     | Auto-increment            |
| `agent_id` | TEXT FK->agents | Affected agent           |
| `delta`    | INTEGER        | Score change (+10, -20)   |
| `reason`   | TEXT           | Event type string         |
| `order_id` | TEXT           | Related transaction       |
| `created_at`| TIMESTAMPTZ   | Timestamp                 |

#### Other existing tables

| Table           | Purpose                                             | Arbitova status     |
|-----------------|-----------------------------------------------------|--------------------|
| `deposits`      | On-chain USDC deposit records                       | Keep               |
| `withdrawals`   | Withdrawal requests + tx hashes                     | Keep               |
| `payments`      | LemonSqueezy fiat payment records                   | Keep               |
| `subscriptions` | Recurring billing subscriptions                     | Keep (optional)    |
| `order_bundles` | Atomic multi-order groups                           | Keep               |
| `reviews`       | Buyer reviews of sellers                            | Keep (optional)    |
| `files`         | Uploaded digital product files                      | Keep (optional)    |
| `messages`      | In-platform notifications                           | Keep (optional)    |
| `telegram_commands` | Telegram bot integration                        | Deprecate/remove   |

### 6.2 New tables needed

#### `webhooks` -- Outbound webhook registrations

```sql
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  url         TEXT NOT NULL,
  events      JSONB NOT NULL,           -- ["transaction.completed", "dispute.resolved"]
  secret      TEXT NOT NULL,            -- HMAC signing secret
  is_active   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_triggered_at TIMESTAMPTZ
);
```

#### `webhook_deliveries` -- Delivery log for debugging

```sql
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id),
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  response_code INTEGER,
  attempts     INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'pending',  -- pending / delivered / failed
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
```

#### `api_keys` -- Multiple keys per agent (replaces single `agents.api_key`)

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  key_hash    TEXT NOT NULL,            -- SHA-256 hash of the key (never store plaintext)
  key_prefix  TEXT NOT NULL,            -- first 8 chars for display: "sk-a1b2..."
  name        TEXT,                     -- user-assigned label
  scope       TEXT DEFAULT 'full',      -- 'full' | 'read' | 'transactions'
  is_active   BOOLEAN DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### 6.3 Schema changes needed

| Change                                        | Migration                                                |
|-----------------------------------------------|----------------------------------------------------------|
| Add `webhooks` table                          | Add to `initSchema()` in `src/db/schema.js`             |
| Add `webhook_deliveries` table                | Add to `initSchema()` in `src/db/schema.js`             |
| Add `api_keys` table                          | Add to `initSchema()` in `src/db/schema.js`             |
| Deprecate `services.market_type` column       | No removal needed; stop writing to it                    |
| Deprecate `telegram_commands` table           | No removal needed; stop reading from it                  |
| Add `orders.webhook_notified` column          | `ALTER TABLE orders ADD COLUMN webhook_notified BOOLEAN DEFAULT FALSE` |

---

## Part 7: Deployment & Infrastructure

### 7.1 Current setup (keep as-is)

| Component          | Provider    | Details                                              |
|--------------------|-------------|------------------------------------------------------|
| Application server | Render      | Web Service, auto-deploy from Git                    |
| Database (prod)    | Render / Railway | PostgreSQL, `DATABASE_URL` env var              |
| Database (dev)     | Local       | SQLite file at `data/a2a.db`                         |
| Domain             | TBD         | `api.arbitova.com` (CNAME to Render)                  |
| SSL                | Render      | Auto-provisioned Let's Encrypt                       |

### 7.2 Environment variables

| Variable              | Required | Description                                    |
|-----------------------|----------|------------------------------------------------|
| `DATABASE_URL`        | Prod     | PostgreSQL connection string                   |
| `ANTHROPIC_API_KEY`   | Yes      | For AI arbitration (Claude Haiku)              |
| `ADMIN_KEY`           | Yes      | Admin endpoint authentication                  |
| `ALCHEMY_API_KEY`     | Optional | Base L2 RPC access (chain mode)                |
| `WALLET_ENCRYPTION_KEY`| Optional | AES key for wallet private key encryption     |
| `CHAIN`               | Optional | Chain identifier, default `base-sepolia`       |
| `LEMONSQUEEZY_API_KEY`| Optional | Fiat payment gateway                           |
| `ALLOWED_ORIGIN`      | Optional | Additional CORS origin                         |
| `PORT`                | Optional | Server port, default `3000`                    |
| `NODE_ENV`            | Optional | `production` / `test`                          |
| `WEBHOOK_SIGNING_KEY` | New      | Master key for signing outbound webhooks       |

### 7.3 Deployment checklist

1. **Render Web Service**: `npm start` runs `node src/server.js`. Health check at `/health`.
2. **Database**: PostgreSQL auto-detected via `DATABASE_URL`. Schema auto-migrates on startup (idempotent `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`).
3. **Zero-downtime deploy**: Render handles rolling deploys. No database migration tool needed -- schema changes are additive only (new tables, new columns, never drop).
4. **Rate limiting**: 60 req/min per IP in production (configured in `src/server.js:50`). Increase to 10,000 in test mode.
5. **CORS**: Configured for Render deployment URL + localhost + `ALLOWED_ORIGIN` env var (see `src/server.js:34`).
6. **Cron jobs**: Two cron jobs run inside the Node process (see `src/server.js`):
   - Subscription billing: every hour (`0 * * * *`)
   - Order expiry + auto-refund: every 10 minutes (`*/10 * * * *`)

### 7.4 Scaling path (future)

| Phase    | Trigger             | Action                                            |
|----------|---------------------|---------------------------------------------------|
| Phase 0  | < 1K tx/day         | Single Render instance. Current setup.            |
| Phase 1  | 1K-10K tx/day       | Render Pro plan. Add Redis for rate limiting + webhook queue. |
| Phase 2  | 10K-100K tx/day     | Separate API + worker processes. Dedicated PostgreSQL (Supabase or Neon). BullMQ for async jobs. |
| Phase 3  | 100K+ tx/day        | Horizontal scaling behind load balancer. Read replicas. Event sourcing for audit trail. |

### 7.5 Monitoring

| What                  | How                                               |
|-----------------------|---------------------------------------------------|
| Uptime                | Render health check at `/health`                  |
| Errors                | `console.error` to Render logs (upgrade to Sentry in Phase 1) |
| Transaction volume    | `GET /api/stats` endpoint (30s cache)             |
| Webhook failures      | `webhook_deliveries` table (query `status = 'failed'`) |
| Database performance  | PostgreSQL `pg_stat_statements` (Phase 1)         |

---

## Appendix A: Transaction Fee Structure

| Fee type        | Rate    | Charged to | When                               |
|-----------------|---------|------------|-------------------------------------|
| Platform fee    | 2.5%    | Seller     | Deducted on escrow release          |
| Dispute fee     | 0%      | N/A        | Free (funded by platform fee margin)|
| Withdrawal fee  | Gas cost| Requester  | On-chain USDC transfer              |

Defined as `PLATFORM_FEE_RATE = 0.025` in `src/routes/orders.js:12`.

## Appendix B: File Index

```
src/
  server.js              -- Express app, middleware, cron jobs
  verify.js              -- JSON Schema + rules verification engine
  arbitrate.js           -- AI arbitration (Claude Haiku)
  wallet.js              -- Base L2 wallet generation + USDC balance
  webhook.js             -- Inbound webhook handler (LemonSqueezy)
  openapi.json           -- OpenAPI 3.0 spec for Swagger UI
  db/
    schema.js            -- Database schema + dual-mode (PG/SQLite)
    helpers.js           -- dbGet, dbAll, dbRun, dbTransaction wrappers
  middleware/
    auth.js              -- X-API-Key authentication middleware
  routes/
    agents.js            -- Identity, reputation, wallet, stake
    services.js          -- Contract CRUD
    orders.js            -- Escrow, deliver, confirm, dispute, arbitrate
    payments.js          -- Fiat payments (LemonSqueezy)
    withdrawals.js       -- USDC withdrawals
    subscriptions.js     -- Recurring billing
    reviews.js           -- Buyer reviews
    messages.js          -- In-platform notifications
    files.js             -- File upload/download
    admin.js             -- Admin endpoints
    telegram.js          -- Telegram bot (deprecated)
  [NEW] webhooks.js      -- Outbound webhook dispatcher (to build)

sdk/                     -- Node.js SDK (skeleton created)
  index.js               -- Arbitova class, WebhooksAPI class
  package.json           -- @arbitova/sdk, version 0.1.0
scripts/
  catalog.js             -- Demo service contracts for developer sandbox (NOT marketplace)
  setup-catalog.js       -- Seeds demo contracts into a fresh database
  seller-agent.js        -- Reference A2A seller agent implementation
  e2e-test.js            -- End-to-end integration test
```

---

## Part 8: Execution Roadmap (Stripe Model)

### Strategic positioning

Arbitova follows the **Stripe model**, not the Visa model:

| Visa model | Stripe model |
|---|---|
| Define an open protocol, give up control, build governance coalition | Build a product so good developers choose it by default |
| Long-term play (decades) | Medium-term play (2-5 years) |
| Requires industry coordination | Requires only developer love |
| Competitive moat: network effects + standards | Competitive moat: developer experience + reliability |

**Current stage**: Building the product foundation. The goal of M1–M3 is to reach a state where a developer can open the docs, run a transaction, and integrate Arbitova into their agent — without asking anyone for help. That is the Stripe benchmark.

---

### Milestone 1 — Infrastructure complete (target: Month 1)

Goal: every API endpoint exists, versioned, and behaves predictably.

| Task | Status | Notes |
|---|---|---|
| `/api/v1/` route prefix | Done | Legacy routes kept as aliases |
| SDK skeleton (`sdk/index.js`) | Done | `Arbitova` class, all core methods |
| Webhook outbound system | Not started | `src/webhooks.js` + `webhooks` table + retry queue |
| Multiple API keys per agent | Not started | `api_keys` table, `POST /api/v1/api-keys` |
| Transaction timeline endpoint | Not started | `GET /api/v1/transactions/:id/timeline` |
| Health endpoint with version | Done | `GET /api/v1/health` |
| Branding: rename all "Arbitova" → platform name | Partially done | `src/server.js` log message still says "Arbitova" |

**Exit criterion**: Every endpoint listed in Part 3 exists and returns correct responses.

---

### Milestone 2 — Developer can self-onboard (target: Month 2)

Goal: a developer reads the docs, runs their first transaction, without help.

| Task | Status | Notes |
|---|---|---|
| Publish `@arbitova/sdk` to npm | Not started | `npm publish` from `sdk/` folder |
| Quickstart guide page | Not started | Register → create contract → place order → deliver → confirm (5 min flow) |
| API Reference page | Not started | Every endpoint: method, path, params, example request, example response |
| Error codes standardized | Not started | Each error has a `code` field (e.g. `insufficient_balance`, `contract_not_found`) |
| Sandbox / test mode documented | Not started | Document mock mode (no real money, 100 USDC auto-credited on register) |
| `GET /api/v1/` returns API overview | Not started | List of available endpoints + version info |

**Exit criterion**: A developer with no prior knowledge can complete a full escrow transaction in under 15 minutes using only the docs.

---

### Milestone 3 — Trust signals (target: Month 3)

Goal: a developer who finds Arbitova for the first time trusts it enough to integrate.

| Task | Status | Notes |
|---|---|---|
| Custom domain (`api.arbitova.com`) | Not started | CNAME to Render, SSL auto-provisioned |
| Webhook signature verification | Not started | `X-Arbitova-Signature` header, HMAC-SHA256 |
| Rate limit headers | Not started | `X-RateLimit-Remaining`, `X-RateLimit-Reset` in all responses |
| Status page | Not started | Simple uptime indicator at `/status` or external (e.g. Betteruptime free tier) |
| Python SDK (`arbitova` on PyPI) | Not started | Thin `httpx`-based wrapper, mirrors Node SDK API |

**Exit criterion**: A developer comparing Arbitova to a competitor sees professional infrastructure, not a side project.

---

### Milestone 4 — First real customer (ongoing from Month 1)

Goal: one developer or team runs real transactions with real money through Arbitova.

This is the most important milestone and cannot be built — it must be found.

**What "real" means**:
- Real API key (not mock mode)
- Real USDC or fiat payment flowing
- At least one completed transaction per week

**How to find them**:
- Developer communities where agent frameworks are discussed (LangChain Discord, CrewAI Discord, Hugging Face forums)
- AI hackathons — offer Arbitova as the payment layer for teams building multi-agent systems
- Direct outreach to developers building agent pipelines on GitHub

**What to offer them**:
- Free usage for first 3 months (waive 2.5% fee)
- Direct support (fast response to any integration issues)
- Their logo on the website as a design partner

**Exit criterion**: One developer sends a message saying "it works, I'm using it in production."

---

### Build order (week-by-week)

```
Week 1–2:   Webhook system (src/webhooks.js + DB tables + retry logic)
Week 3:     Publish SDK to npm + write Quickstart page
Week 4:     Error code standardization + API overview endpoint
Week 5–6:   Developer docs (Quickstart + API Reference)
Week 7:     Custom domain + webhook signature verification
Week 8:     Python SDK
Week 9+:    Iterate based on first customer feedback
```

---

### What NOT to build right now

These are explicitly deferred until after M4 (first real customer):

- Python SDK LangChain/CrewAI integration (build after Python SDK exists)
- Governance / open protocol / DAO structure (Visa model — only relevant at scale)
- Mobile app or consumer-facing UI
- Enterprise tier / SLA contracts
- Blockchain settlement layer beyond current Base L2 setup
- Multi-currency support beyond USDC
