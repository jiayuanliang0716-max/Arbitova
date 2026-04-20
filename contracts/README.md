# EscrowV1 — Arbitova On-Chain Escrow (Phase B-1)

Single-token (USDC) escrow contract with buyer / seller / arbiter roles. Funds are locked on creation and only released via explicit buyer confirmation or arbiter resolution. There is no automatic release on timeout — silence always leads to arbitration.

## State Machine

```
CREATED ──markDelivered()──► DELIVERED ──confirmDelivery()──► RELEASED  (terminal)
   │                              │
   │                     escalateIfExpired()   (callable by anyone after reviewDeadline)
   │                     or dispute()
   │                              │
   ├──dispute()──────────────────►┤
   │                              ▼
   │                          DISPUTED ──resolve()──► RESOLVED  (terminal)
   │
   └──cancelIfNotDelivered()──► CANCELLED  (terminal)
```

**Critical invariant**: DELIVERED never auto-transitions to RELEASED. After `reviewDeadline` passes, anyone can call `escalateIfExpired()` to push the escrow to DISPUTED for arbiter resolution.

## Key Parameters

| Parameter | Default | Cap |
|---|---|---|
| `releaseFeeBps` | 50 (0.5%) | 200 (2%) |
| `resolveFeeBps` | 200 (2.0%) | 500 (5%) |
| `deliveryWindowSec` | caller-supplied | 1h to 30d |
| `reviewWindowSec` | caller-supplied | 1h to 30d |

## Fee Model

- **confirmDelivery**: fee deducted from seller's gross payout; buyer pays full amount.
- **resolve**: fee deducted proportionally from each party's allocated share.

## How to Run Tests

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation).

```bash
cd contracts/

# Run all tests
forge test -vv

# Run with coverage report
forge coverage

# Run a specific test
forge test --match-test test_confirmDelivery_transfersToSellerMinusFee -vvv
```

## File Layout

```
contracts/
  foundry.toml                  Foundry config (solc 0.8.24, optimizer runs=200)
  src/
    EscrowV1.sol                Main contract
  test/
    EscrowV1.t.sol              47 tests (unit + fuzz + reentrancy)
  lib/
    forge-std/                  Foundry test helpers
    openzeppelin-contracts/     SafeERC20, ReentrancyGuard, Ownable
```

## Coverage (forge coverage)

| Metric | EscrowV1.sol |
|---|---|
| Lines | 100% (95/95) |
| Functions | 100% (13/13) |
| Statements | 96% (126/131) |
| Branches | 85% (28/33) |

## Security Properties Tested

- ReentrancyGuard: `MaliciousUsdc` attempts re-entry on `confirmDelivery`; blocked.
- Double-spend: second `confirmDelivery` reverts with `WrongState`.
- No timeout release: `escalateIfExpired` moves to DISPUTED only, never RELEASED.
- Fee caps enforced: owner cannot set fees above hard limits.
- All custom error selectors tested via `vm.expectRevert`.
