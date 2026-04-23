# E2E Rehearsal Plan (v0.1)

Before announcing any surface publicly, walk the full buyer-seller
flow end-to-end against the live Sepolia deployment. This doc lists
the scenarios, the expected observable state at each step, and the
pass/fail criteria.

Target: `EscrowV1` at `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`
on Base Sepolia (chainId 84532).

---

## Preconditions

1. Two funded test wallets (buyer, seller) with ≥1 USDC and ≥0.005 ETH
2. Local checkout of `a2a-system` with Node 20+ and Python 3.12
3. Env vars:
   ```
   BASE_SEPOLIA_RPC=...
   ESCROW_ADDRESS=0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC
   USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
   BUYER_PRIVATE_KEY=0x...
   SELLER_PRIVATE_KEY=0x...
   ```
4. Block explorer tab open on Basescan Sepolia at the escrow address

---

## Scenario A — Happy path (RELEASED)

Goal: buyer creates, seller delivers, buyer confirms, funds released
to seller minus fee.

### Steps (JS SDK)

```bash
node scripts/rehearse-happy.js
```

Script should:

1. Buyer: USDC.approve(escrow, 1_000_000) # 1 USDC
2. Buyer: escrow.createEscrow(seller, 1_000_000, deliveryDeadline,
   reviewWindowSec, "ipfs://verificationURI")
3. Seller: escrow.markDelivered(escrowId, deliveryHash)
4. Buyer: escrow.confirmDelivery(escrowId)

### Expected observable state

| Checkpoint | On-chain state | Off-chain |
|---|---|---|
| After step 1 | USDC allowance = 1_000_000 | — |
| After step 2 | Escrow.state = CREATED (0); USDC transferred to contract | EscrowCreated event emitted |
| After step 3 | Escrow.state = DELIVERED (1); deliveryHash set; reviewDeadline set | Delivered event emitted |
| After step 4 | Escrow.state = RELEASED (2); USDC balance at seller = 0.995 USDC; fee recipient balance increased by 0.005 USDC | Released event emitted |

### Pass criteria

- All four transactions confirm
- Final escrow state = RELEASED
- Seller USDC balance change matches expected (gross amount − fee)
- No unexpected events emitted

---

## Scenario B — Dispute path → buyer wins

Goal: seller delivers low-quality output, buyer disputes, arbiter
rules 100/0 for buyer, funds return to buyer minus fee.

### Steps

1. Buyer: approve + createEscrow (amount 1 USDC)
2. Seller: markDelivered
3. Buyer: dispute(escrowId, "output does not match verification criteria")
4. (Off-chain) Claude verdict engine runs; confidence passes gate;
   arbiter signs resolve(escrowId, 10_000, 0, verdictHash)

### Expected observable state

| Checkpoint | State |
|---|---|
| After step 3 | state = DISPUTED (3); Disputed event with reason string |
| After step 4 | state = RESOLVED (4); Resolved event with toBuyer, toSeller, feePaid, verdictHash; buyer balance changed by ~0.98 USDC (gross − buyer-side fee); seller balance unchanged |

### Pass criteria

- state transitions DISPUTED → RESOLVED
- Verdict hash on-chain matches the hash the arbiter computed locally
- Buyer receives gross - fee; seller receives 0
- Fee recipient receives expected fee

---

## Scenario C — Dispute path → split verdict

Goal: ambiguous case, arbiter rules 60/40.

### Steps

Same as B, but arbiter signs `resolve(escrowId, 6000, 4000, verdictHash)`.

### Expected observable state

| Checkpoint | State |
|---|---|
| After resolve | buyer receives 0.6 USDC * (1 - resolveFeeBps/10_000); seller receives 0.4 USDC * (1 - resolveFeeBps/10_000) |

Fees are taken proportionally from each party's allocation — verify
both sides.

---

## Scenario D — Timeout → escalation

Goal: seller delivers but buyer never confirms. After reviewDeadline,
anyone can call `escalateIfExpired(escrowId)` to force DISPUTED.

### Steps

1. Buyer: approve + createEscrow with short reviewWindow (e.g., 60s
   on Sepolia if allowed; else wait real review window)
2. Seller: markDelivered
3. Wait until after reviewDeadline
4. Third party: escalateIfExpired(escrowId)

### Pass criteria

- Transition DELIVERED → DISPUTED (NOT → RELEASED)
- This is the central safety invariant. If this scenario ever
  ends in RELEASED, the contract has a critical bug and the
  mainnet deploy gate is revoked.

---

## Scenario E — Cancel before delivery

Goal: buyer creates escrow, seller never delivers, buyer cancels
after deliveryDeadline and gets full refund (no fee).

### Steps

1. Buyer: approve + createEscrow with short deliveryWindow
2. Wait until after deliveryDeadline
3. Buyer: cancelIfNotDelivered(escrowId)

### Pass criteria

- state transitions CREATED → CANCELLED
- Buyer receives full amount back (no fee on cancellation)
- Seller receives nothing

---

## Scenario F — SDK parity

For each flow A–E, repeat using the Python SDK
(`arbitova.path_b`). Results must match. Any state decoding or
event parsing divergence is a bug.

Additionally:

- MCP server read endpoint `/mcp/getEscrow` returns the same Escrow
  struct fields as the SDKs for the same escrowId
- Event topics parsed off-chain (topic0) match what the SDKs
  register in their ABI blobs

---

## Scenario G — Adapter rehearsal (x402 + CDP)

These exercise the v0.1-alpha adapters. Both are marked "in progress"
on `/integrate`; the rehearsal is a pre-publish sanity check.

### G.1 x402-adapter

- Stand up a test service that returns 402 with
  `X-Arbitova-Escrow: 0xA8a0...@84532` and price header
- Call the service through `withEscrow(fetch, opts)`
- Verify the adapter creates an escrow, retries with escrow-ref
  header, and exposes `confirmLast()` / `disputeLast()`

### G.2 CDP adapter

- Requires a CDP project id + API key on Sepolia
- Run `python examples/path_b/cdp_buyer_demo.py --seller 0x... --amount 1.0 ...`
- Verify step 1 creates escrow via CDP-managed wallet, step 2 reads
  it back, step 3 pauses for `--confirm`
- Run with `--confirm` to release

---

## Rehearsal checklist

Before publishing any "x is live" claim, every scenario above must
have been run at least once within the last 7 days against the
current contract deployment, with tx hashes recorded in
`.arbitova-gm/rehearsal-log.md`.

If a scenario fails:

1. Capture tx hash + revert reason
2. Halt the publish pipeline (do not tweet, do not announce, do not
   merge marketing PRs)
3. Root-cause in code, not in the rehearsal script
4. Re-run the full matrix after the fix

---

## Out of scope for v0.1 rehearsal

- External appeal layer (ruled out for v1 by design — see docs/decisions/M-0-arbiter-architecture-v1.md; UMA OO appeal is Phase 6 research on a possible V2 contract, not v1)
- Multisig arbiter path (not deployed)
- ReputationV1 mint hook (not wired up)
- ERC-4337 session keys (not implemented)
- Pimlico paymaster (not wired up)

These become rehearsal scenarios once their respective design docs
transition to deployed code.
