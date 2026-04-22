# 15 Minutes to a Paid Agent

You have a buyer agent and a seller agent. The buyer wants work done and will pay in USDC. Neither side trusts the other, and there is no middleman holding funds.

This tutorial gets you from zero to a working end-to-end run in about 15 minutes:

1. Buyer creates an on-chain escrow, locking 1 USDC.
2. Seller produces the work, uploads it, calls `markDelivered`.
3. Buyer verifies against criteria, calls `confirmDelivery` (or `dispute`).
4. Contract releases USDC to the seller. You see it on Basescan.

All on Base Sepolia. No API key. No custodian. Uses `ethers.js` directly — no SDK lock-in.

Contract: [`0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`](https://sepolia.basescan.org/address/0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC) on Base Sepolia.

---

## What you need

- Node 18+
- A test wallet with some Sepolia ETH (for gas) and 2+ Sepolia USDC
- 15 minutes

If you already have a funded Sepolia wallet, skip to [step 2](#2-install-deps).

### 1. Get test wallets and fund them

You will need **two** addresses (buyer + seller). Generate them if you don't have them:

```bash
node -e "const {Wallet}=require('ethers'); for (const who of ['buyer','seller']) { const w=Wallet.createRandom(); console.log(who, w.address, w.privateKey); }"
```

Fund both addresses:

- **Base Sepolia ETH for gas** — [coinbase.com/faucets/base-ethereum-sepolia-faucet](https://coinbase.com/faucets/base-ethereum-sepolia-faucet). 0.05 ETH is plenty for dozens of runs.
- **Base Sepolia USDC for the escrow** — [faucet.circle.com](https://faucet.circle.com), select Base Sepolia. Send 2+ USDC to the buyer.

### 2. Install deps

```bash
mkdir paid-agent-demo && cd paid-agent-demo
npm init -y
npm install ethers dotenv
```

### 3. Configure env

Create `.env` in the same folder:

```env
# Base Sepolia — canonical Arbitova deployment
RPC_URL=https://sepolia.base.org
ESCROW_ADDRESS=0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e

# Buyer wallet
BUYER_PRIVATE_KEY=0xyourbuyerkey
SELLER_ADDRESS=0xyoursellerpublicaddress

# Seller wallet
SELLER_PRIVATE_KEY=0xyoursellerkey
```

### 4. Shared ABI helper

Save as `escrow.js` — both scripts import it:

```javascript
// escrow.js — minimal ABI + contract factory
const { ethers } = require('ethers');

const ESCROW_ABI = [
  'function createEscrow(address seller, uint256 amount, uint64 deliveryWindowSec, uint64 reviewWindowSec, string verificationURI) returns (uint256)',
  'function markDelivered(uint256 id, bytes32 deliveryHash)',
  'function confirmDelivery(uint256 id)',
  'function dispute(uint256 id, string reason)',
  'function getEscrow(uint256 id) view returns (tuple(address buyer, address seller, uint256 amount, uint64 deliveryDeadline, uint64 reviewDeadline, uint64 reviewWindowSec, uint8 state, bytes32 deliveryHash, string verificationURI))',
  'event EscrowCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint256 amount, uint64 deliveryDeadline, string verificationURI)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

const STATUS = ['CREATED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'CANCELLED'];

function wallets(privateKey) {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const wallet = new ethers.Wallet(privateKey, provider);
  const escrow = new ethers.Contract(process.env.ESCROW_ADDRESS, ESCROW_ABI, wallet);
  const usdc = new ethers.Contract(process.env.USDC_ADDRESS, ERC20_ABI, wallet);
  return { wallet, escrow, usdc };
}

module.exports = { ESCROW_ABI, ERC20_ABI, STATUS, wallets };
```

### 5. Seller script

Save as `seller.js`:

```javascript
require('dotenv').config();
const { ethers } = require('ethers');
const { wallets } = require('./escrow');

async function main() {
  const escrowId = process.argv[2];
  if (!escrowId) { console.error('Usage: node seller.js <escrowId>'); process.exit(1); }

  const { escrow } = wallets(process.env.SELLER_PRIVATE_KEY);

  // In real life: do the work, upload the output, return a stable URL.
  // The contract stores keccak256 of this URI as an on-chain commitment.
  const deliveryPayloadURI =
    'https://raw.githubusercontent.com/jiayuanliang0716-max/Arbitova/master/examples/path_b/sample_delivery.md';
  const deliveryHash = ethers.keccak256(ethers.toUtf8Bytes(deliveryPayloadURI));

  console.log(`[Seller] markDelivered(${escrowId}, ${deliveryHash})`);
  const tx = await escrow.markDelivered(BigInt(escrowId), deliveryHash);
  const receipt = await tx.wait();
  console.log(`[Seller] Delivered. tx: https://sepolia.basescan.org/tx/${receipt.hash}`);
}

main().catch(e => { console.error('[Seller]', e.shortMessage || e.message); process.exit(1); });
```

### 6. Buyer script

Save as `buyer.js`:

```javascript
require('dotenv').config();
const { ethers } = require('ethers');
const { wallets, STATUS } = require('./escrow');

const VERIFICATION_URI =
  'https://raw.githubusercontent.com/jiayuanliang0716-max/Arbitova/master/examples/path_b/sample_criteria.json';
const DELIVERY_URI =
  'https://raw.githubusercontent.com/jiayuanliang0716-max/Arbitova/master/examples/path_b/sample_delivery.md';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { wallet, escrow, usdc } = wallets(process.env.BUYER_PRIVATE_KEY);
  const seller = process.env.SELLER_ADDRESS;

  const decimals = await usdc.decimals();
  const amount = ethers.parseUnits('1', decimals);

  // 1. Approve USDC to the escrow contract
  console.log('[Buyer] Approving 1 USDC to EscrowV1...');
  await (await usdc.approve(process.env.ESCROW_ADDRESS, amount)).wait();

  // 2. Create the escrow
  console.log(`[Buyer] createEscrow: seller=${seller}, amount=1 USDC`);
  const tx = await escrow.createEscrow(
    seller,
    amount,
    3600n,  // 1 hour delivery window
    3600n,  // 1 hour review window
    VERIFICATION_URI,
  );
  const receipt = await tx.wait();

  // Pull the escrowId out of the EscrowCreated event
  let escrowId;
  for (const log of receipt.logs) {
    try {
      const parsed = escrow.interface.parseLog(log);
      if (parsed?.name === 'EscrowCreated') { escrowId = parsed.args.id.toString(); break; }
    } catch (_) { /* skip non-escrow logs */ }
  }
  console.log(`[Buyer] Escrow ${escrowId} created. tx: https://sepolia.basescan.org/tx/${receipt.hash}`);
  console.log(`[Buyer] -> In a second terminal:  node seller.js ${escrowId}`);

  // 3. Poll until seller marks delivered
  let state;
  for (let i = 0; i < 60; i++) {
    await sleep(10_000);
    state = await escrow.getEscrow(BigInt(escrowId));
    const status = STATUS[Number(state.state)];
    console.log(`[Buyer] state=${status}`);
    if (status === 'DELIVERED') break;
    if (['CANCELLED', 'DISPUTED', 'RELEASED', 'RESOLVED'].includes(status)) {
      console.error(`[Buyer] Unexpected state: ${status}`); process.exit(1);
    }
  }

  // 4. Verify against criteria
  const criteria = await (await fetch(VERIFICATION_URI)).json();
  const delivered = await (await fetch(DELIVERY_URI)).text();
  const wordCount = delivered.trim().split(/\s+/).length;
  const hasSummary = /executive summary/i.test(delivered);
  console.log(`[Buyer] criteria=${criteria.criteria.length}, wordCount=${wordCount}, hasSummary=${hasSummary}`);

  if (wordCount >= 50 && hasSummary) {
    console.log('[Buyer] All criteria pass. confirmDelivery.');
    const c = await (await escrow.confirmDelivery(BigInt(escrowId))).wait();
    console.log(`[Buyer] USDC released. tx: https://sepolia.basescan.org/tx/${c.hash}`);
  } else {
    const reason = `word count=${wordCount} (need >=50), executive summary=${hasSummary}`;
    console.log(`[Buyer] Disputing: ${reason}`);
    const d = await (await escrow.dispute(BigInt(escrowId), reason)).wait();
    console.log(`[Buyer] Dispute filed. tx: https://sepolia.basescan.org/tx/${d.hash}`);
  }
}

main().catch(e => { console.error('[Buyer]', e.shortMessage || e.message); process.exit(1); });
```

### 7. Run both

Terminal 1:

```bash
node buyer.js
```

When it prints `-> In a second terminal: node seller.js <id>`, do that in Terminal 2:

```bash
node seller.js <id>
```

Terminal 2 exits after marking delivered. Terminal 1 polls, sees `DELIVERED`, fetches the delivery, verifies, confirms. Both tx hashes printed, both clickable on Basescan.

### 8. Watch it on-chain

Open either tx in Basescan. You will see:

- `createEscrow` — 1 USDC transferred from buyer → `EscrowV1`
- `markDelivered` — `Delivered(id, deliveryHash, reviewDeadline)` event from the seller's wallet
- `confirmDelivery` — 0.995 USDC to the seller, 0.005 USDC protocol fee (0.5%)

At no point did either wallet trust the other. At no point did any service hold your funds.

---

## What just happened

Three contract calls. One state machine. Five minutes of wall-clock time once both wallets are funded.

```
CREATED ──markDelivered──▶ DELIVERED ──confirmDelivery──▶ RELEASED (USDC to seller)
                              │
                              └──dispute──▶ DISPUTED ──resolve──▶ RESOLVED (arbiter splits)
```

Two rules that are easy to miss:

1. **Silence is not consent.** If the buyer does nothing inside `reviewWindowSec`, funds do not auto-release. The escrow stays in `DELIVERED` until someone calls `confirmDelivery`, `dispute`, or the arbiter resolves it. This is the opposite of most Web2 escrows and it is what makes the buyer side safe.

2. **`deliveryHash = keccak256(deliveryPayloadURI)`.** The contract stores a commitment, not the content. If the seller swaps the file after marking delivered, the arbiter will notice during a dispute (the URI no longer hashes to what's on-chain). Put the deliverable on IPFS or a content-addressed store for end-to-end integrity.

---

## Where to go next

- **Plug into your agent framework.** The [LangGraph](https://github.com/jiayuanliang0716-max/Arbitova/tree/master/examples) and [CrewAI](https://github.com/jiayuanliang0716-max/Arbitova/tree/master/examples) demos wrap these same calls as agent tools. ~50 lines per framework.
- **See a real dispute.** Change `DELIVERY_URI` in `buyer.js` to something that fails the criteria (e.g. a paragraph without an "Executive Summary" heading). Run again — buyer files a dispute, arbiter resolves.
- **Mainnet.** Swap two addresses:
  - `ESCROW_ADDRESS` → mainnet deployment (see [README](https://github.com/jiayuanliang0716-max/Arbitova#deployments))
  - `USDC_ADDRESS` → `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

  Same code. Real USDC.

## If something broke

| Error | Fix |
|---|---|
| `insufficient funds for gas` | Fund the wallet with Base Sepolia ETH from the faucet |
| `ERC20: transfer amount exceeds balance` | Fund the buyer wallet with Base Sepolia USDC |
| `execution reverted: NOT_BUYER` / `NOT_SELLER` | Wallets got mixed up — buyer key must match the creator; seller key must match `SELLER_ADDRESS` |
| `execution reverted: BAD_STATE` | The escrow is not in the expected state. Run `getEscrow` to see current status |
| Buyer polls forever, seller printed success | You're looking at two different escrow IDs. Pass the one printed by `buyer.js` |

## Help wanted

If you hit friction the table above doesn't cover, open an issue: [github.com/jiayuanliang0716-max/Arbitova/issues](https://github.com/jiayuanliang0716-max/Arbitova/issues). Tutorial friction reports are high-leverage — one clear "I got stuck here" beats a dozen stars.
