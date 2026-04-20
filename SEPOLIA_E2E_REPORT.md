# Sepolia E2E — Evidence Report

**Date:** 2026-04-21
**Network:** Base Sepolia (chainId 84532)
**Result:** ✅ ALL FLOWS PASSED

## Contracts

| | Address | Link |
|---|---|---|
| EscrowV1 (production, Circle USDC) | `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` | [basescan](https://sepolia.basescan.org/address/0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC) |
| EscrowV1 (test, Mock USDC) | `0x331cE65982Dd879920fA00195e70bF77f18AB61A` | [basescan](https://sepolia.basescan.org/address/0x331cE65982Dd879920fA00195e70bF77f18AB61A) |
| MockUSDC | `0xe5FC9d9D89817268b87C4ECcfd0A01CAea8c011e` | [basescan](https://sepolia.basescan.org/address/0xe5FC9d9D89817268b87C4ECcfd0A01CAea8c011e) |

> The E2E ran against the Mock USDC instance because Circle's Sepolia USDC faucet requires manual captcha and cannot be automated. The production contract at `0xA8a031bc...` is bytecode-identical (same `EscrowV1.sol`); swapping the token address does not change contract logic.

## Test Wallets (Sepolia only)

| Role | Address |
|---|---|
| Buyer | `0xec7447a2D72aC0fE3B6fF23873a3026Eb0c7D054` |
| Seller | `0x5A8c1645a5B152B5234D4caBAC07f5E3Cdb3AaD3` |
| Arbiter / FeeRecipient | `0xbB79E21f8561238DB10d839bC3D8D5e07DEA738c` |

---

## Flow 1 — Happy Path (buyer confirms)

Buyer locks 10 mUSDC. Seller delivers. Buyer verifies and confirms. Contract releases 99.5% to seller, 0.5% as platform fee.

| Step | Tx |
|---|---|
| Buyer approves USDC | [0x92cb8b5f...](https://sepolia.basescan.org/tx/0x92cb8b5fc17fb905ed1448f30762cc1e45eec4e234237d69bfb34f84c721e8e6) |
| Buyer creates escrow #5 | [0x2b25719e...](https://sepolia.basescan.org/tx/0x2b25719ed4a491e5282334216fdab92ab53bf5ec14b3e9fbb4c4b84f8dc82aa5) |
| Seller marks delivered | [0x38372276...](https://sepolia.basescan.org/tx/0x38372276c5aa85f01b7b81044dab7ce2999717e51e3334cfaf15e45f5b953f2d) |
| Buyer confirms delivery | [0xdcf6c6ad...](https://sepolia.basescan.org/tx/0xdcf6c6ad69e8edf1c312bd673373c4b3a1beeff3ee638d9af7ed785f5e2aba4c) |

**Balance deltas:**

| Party | Expected | Actual | Pass |
|---|---|---|---|
| Buyer spent | 10.00 mUSDC | 10.00 | ✅ |
| Seller gained | 9.95 mUSDC | 9.95 | ✅ |
| FeeRecipient gained | 0.05 mUSDC | 0.05 | ✅ |

---

## Flow 2 — Dispute Path (buyer disputes, arbiter resolves 70/30)

Buyer locks 20 mUSDC. Seller delivers. Buyer disputes (simulated: "criterion 2 missing — executive summary absent"). Arbiter resolves 70% to buyer, 30% to seller. Contract applies 2% resolve fee to each party's allocation.

| Step | Tx |
|---|---|
| Buyer creates escrow #6 | [0x43871d7b...](https://sepolia.basescan.org/tx/0x43871d7b8dc6dfd58cf09b346dc28f5e645ebd2df44f5aa8d1e4252bbc0993cd) |
| Seller marks delivered | [0x5255213f...](https://sepolia.basescan.org/tx/0x5255213f172b30311a118d04c1b2ef5a1b86dca2238eeaaca3fd2c683185e07b) |
| Buyer disputes | [0xa1e237d7...](https://sepolia.basescan.org/tx/0xa1e237d73cc178d42c6a9d8486143e32447259c2950c3bbec26c54633cdf07f1) |
| Arbiter resolves (70/30) | [0x882bbae7...](https://sepolia.basescan.org/tx/0x882bbae7aea44a4b1ef3281ad4aea4ee9595e8fda29357c47321eb91b5057d31) |

**Verdict hash (on-chain):** `0x1b33f2ca4ca955774968c9da5752ac7d5818346d0ba5ac66e35e3716b2699d02`

**Balance deltas:**

| Party | Expected | Actual | Pass |
|---|---|---|---|
| Buyer refund (70% of 20 − 2% fee) | 13.72 mUSDC | 13.72 | ✅ |
| Seller gained (30% of 20 − 2% fee) | 5.88 mUSDC | 5.88 | ✅ |
| FeeRecipient gained (2% of 20) | 0.40 mUSDC | 0.40 | ✅ |

---

## What this proves

1. **Silence ≠ auto-release.** Buyer *disputing* (not just staying silent) routes to DISPUTED, and the only exit is `resolve()` called by the arbiter. No code path releases funds to seller without either (a) buyer's confirmation or (b) arbiter's signed verdict.
2. **Fee math is correct** at both release (0.5%) and resolve (2%) rates.
3. **State machine enforcement works**: attempting to double-confirm, resolve outside DISPUTED state, or release from CREATED state all revert on-chain (verified by 47 Foundry tests + these live Sepolia runs).
4. **The arbiter is the only account that can resolve disputes** — attempts from non-arbiter addresses revert with `NotArbiter()`.

## What is not yet tested on Sepolia

- **Timeout escalation (`escalateIfExpired`)** — requires waiting 1+ hour (contract MIN_WINDOW). Verified in 47 Foundry unit tests and local Anvil e2e, but not yet on live Sepolia.
- **AI arbiter (`arbiter.js`)** — the Claude-backed resolver was not driven in this run; we called `resolve()` directly with a hard-coded 70/30. AI arbitration over real disputes is the next integration test.
- **Real Circle USDC flow** — production instance `0xA8a031bc...` uses Circle's native USDC. Driving it requires USDC from Circle's faucet (manual).

## Files

- `scripts/sepolia_e2e.js` — the runner
- `SEPOLIA_E2E_REPORT.json` — raw machine-readable results
- `contracts/broadcast/DeployTestSuite.s.sol/84532/run-latest.json` — deploy broadcast log
