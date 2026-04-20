# Migration Guide: Path A (Custodial API) → Path B (On-chain Escrow)

## What changes

**Path A** (existing SDK): Arbitova holds funds in custody. You call our REST API. Simple, no wallet required.

**Path B** (this guide): Funds flow directly through the `EscrowV1` smart contract. You hold your own wallet and private key. Arbitova is never a custodian. Every action is an on-chain transaction.

| Aspect | Path A | Path B |
|--------|--------|--------|
| Fund custody | Arbitova custodial balance | Your wallet / smart contract |
| API calls | REST HTTP | On-chain transactions via ethers v6 |
| Auth | `ARBITOVA_API_KEY` | `ARBITOVA_AGENT_PRIVATE_KEY` (wallet) |
| New dependency | None | `ethers` v6 (already in repo) |
| Transaction fees | None (off-chain) | Gas fees on Base/Ethereum |
| Migration required? | No — Path A still works | Opt-in, additive |

## What stays the same

- Tool naming convention: `arbitova_*`
- Return shapes: `{ok: true, ...}` / `{ok: false, error, hint}`
- Tool definitions are OpenAI-style (AutoGen, LangChain, Anthropic function calling all work)
- Same MCP server (now also exposes Path B prompt resources)

## Side-by-side code comparison

### Creating an escrow

**Path A**
```js
const { Arbitova } = require('@arbitova/sdk');
const client = new Arbitova({ apiKey: process.env.ARBITOVA_API_KEY });

const order = await client.escrow('svc_abc123', {
  requirements: { task: 'write a summary' },
});
// order.id, order.status, order.amount
```

**Path B**
```js
const { arbitova_create_escrow } = require('@arbitova/sdk/pathB');
// Requires: ARBITOVA_RPC_URL, ARBITOVA_ESCROW_ADDRESS,
//           ARBITOVA_USDC_ADDRESS, ARBITOVA_AGENT_PRIVATE_KEY

const result = await arbitova_create_escrow({
  seller: '0xSellerAddress',
  amount: 50,                        // USDC
  deliveryWindowHours: 24,
  reviewWindowHours: 24,
  verificationURI: 'https://your-host/criteria.json',
});
// result.ok, result.txHash, result.escrowId
```

### Confirming delivery

**Path A**
```js
await client.confirm(order.id);
```

**Path B**
```js
// MUST fetch and verify delivery first. See buyer-verification prompt.
const { arbitova_confirm_delivery, arbitova_dispute } = require('@arbitova/sdk/pathB');

// Only after checking all criteria:
const result = await arbitova_confirm_delivery({ escrowId: '1' });

// If anything is wrong:
const result = await arbitova_dispute({ escrowId: '1', reason: 'Criterion 2 not met: ...' });
```

### Python

**Path A**
```python
from arbitova import Arbitova
client = Arbitova(api_key=os.environ["ARBITOVA_API_KEY"])
order = client.escrow("svc_abc123", requirements={"task": "summarize"})
```

**Path B**
```python
from arbitova.path_b import arbitova_create_escrow, arbitova_confirm_delivery, arbitova_dispute
# Requires: ARBITOVA_RPC_URL, ARBITOVA_ESCROW_ADDRESS,
#           ARBITOVA_USDC_ADDRESS, ARBITOVA_AGENT_PRIVATE_KEY

result = arbitova_create_escrow(
    seller="0xSellerAddress",
    amount=50,
    verification_uri="https://your-host/criteria.json",
)
```

## New env vars required for Path B

```sh
ARBITOVA_RPC_URL=https://mainnet.base.org        # or sepolia.base.org for testing
ARBITOVA_ESCROW_ADDRESS=<deployed contract>       # fill in after deploy
ARBITOVA_USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # Base mainnet
ARBITOVA_AGENT_PRIVATE_KEY=0x...                  # your agent wallet key
```

USDC Sepolia (for testing): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

## MCP prompt resources (new in Path B)

Load these into your agent before handling escrow events:

```
arbitova://prompts/buyer-verification   — verification checklist for buyers
arbitova://prompts/seller-delivery      — delivery checklist for sellers
arbitova://prompts/arbitrator-self-check — for LLM-as-arbitrator use cases
arbitova://resources/escrow-abi         — EscrowV1 ABI JSON
```

## FAQ

**Do I have to migrate?** No. Path A (`ARBITOVA_API_KEY` + REST) continues to work. Path B is an opt-in alternative for teams that want non-custodial, on-chain settlement.

**Can I use both in the same agent?** Yes. Import from `sdk/index.js` (Path A) and `sdk/pathB.js` (Path B) independently.

**Will Path A be deprecated?** Not announced. This guide will be updated if that changes.
