// @arbitova/paymaster-policy
//
// Pure-logic sponsorship decision for an Arbitova-branded Pimlico paymaster.
// Does NOT talk to a bundler, does NOT sign anything. Takes a decoded
// UserOperation + runtime budget state, returns {sponsor, reason}.
//
// The real paymaster service wraps this function: on each incoming
// sponsorship request, decode the callData, feed it here, and only sign
// the paymasterAndData blob when this returns sponsor=true.

// -----------------------------------------------------------------------------
// Selectors that EscrowV1 exposes externally.
// Kept as a constant so the policy reviewer can see the exact call surface.
// -----------------------------------------------------------------------------

export const ESCROW_SELECTORS = Object.freeze({
  createEscrow:          "0x8f5f77b9", // createEscrow(address,uint256,uint64,uint64,string)
  markDelivered:         "0x5b5d5ec6", // markDelivered(uint256,bytes32)
  confirmDelivery:       "0xd9ceafff", // confirmDelivery(uint256)
  dispute:               "0x60c8dcba", // dispute(uint256,string)
  cancelIfNotDelivered:  "0x8c23d15d", // cancelIfNotDelivered(uint256)
  escalateIfExpired:     "0x1f63f5f9", // escalateIfExpired(uint256)
});

// USDC (ERC-20) approve selector.
export const USDC_APPROVE_SELECTOR = "0x095ea7b3"; // approve(address,uint256)

// -----------------------------------------------------------------------------
// normalizeAddr — lowercase compare without forcing callers to do it
// -----------------------------------------------------------------------------

function normalizeAddr(addr) {
  if (typeof addr !== "string") return "";
  return addr.toLowerCase();
}

// -----------------------------------------------------------------------------
// Decide whether to sponsor a single UserOperation.
//
// Inputs:
//   op     — decoded UserOperation { sender, callTarget, callSelector,
//                                    callApproveSpender?, estGasCostWei }
//   cfg    — { escrowAddress, usdcAddress, perOpGasCeilingWei }
//   budget — { spentTodayWei, dailyBudgetWei }
//
// Returns:
//   { sponsor: boolean, reason: string }
//
// Design choice: REJECT by default. Every allow-branch must be explicit.
// -----------------------------------------------------------------------------

export function decideSponsorship(op, cfg, budget) {
  if (!op || typeof op !== "object") {
    return { sponsor: false, reason: "op missing" };
  }
  if (!cfg?.escrowAddress || !cfg?.usdcAddress) {
    return { sponsor: false, reason: "cfg missing contract addresses" };
  }

  const target = normalizeAddr(op.callTarget);
  const escrow = normalizeAddr(cfg.escrowAddress);
  const usdc   = normalizeAddr(cfg.usdcAddress);
  const selector = (op.callSelector || "").toLowerCase();

  // Gas ceiling
  const gasCost = BigInt(op.estGasCostWei ?? 0);
  const gasCeiling = BigInt(cfg.perOpGasCeilingWei ?? 0);
  if (gasCeiling > 0n && gasCost > gasCeiling) {
    return {
      sponsor: false,
      reason: `per-op gas ${gasCost} exceeds ceiling ${gasCeiling}`,
    };
  }

  // Daily budget
  const spent = BigInt(budget?.spentTodayWei ?? 0);
  const daily = BigInt(budget?.dailyBudgetWei ?? 0);
  if (daily > 0n && spent + gasCost > daily) {
    return {
      sponsor: false,
      reason: `daily budget exceeded (spent ${spent} + op ${gasCost} > ${daily})`,
    };
  }

  // Target must be EscrowV1 or USDC
  if (target === escrow) {
    const allowed = Object.values(ESCROW_SELECTORS).includes(selector);
    if (!allowed) {
      return {
        sponsor: false,
        reason: `escrow selector ${selector} not in allow-list`,
      };
    }
    return { sponsor: true, reason: "escrow call within policy" };
  }

  if (target === usdc) {
    if (selector !== USDC_APPROVE_SELECTOR) {
      return {
        sponsor: false,
        reason: `usdc call must be approve (0x095ea7b3), got ${selector}`,
      };
    }
    const spender = normalizeAddr(op.callApproveSpender);
    if (spender !== escrow) {
      return {
        sponsor: false,
        reason: `usdc approve must target escrow, got spender ${spender}`,
      };
    }
    return { sponsor: true, reason: "usdc.approve(escrow) within policy" };
  }

  return {
    sponsor: false,
    reason: `target ${target} is neither escrow nor usdc`,
  };
}
