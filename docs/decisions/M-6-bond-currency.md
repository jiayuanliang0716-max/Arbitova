# M-6 Decision Brief: Appeal Bond Currency

Status: **AWAITING FOUNDER DECISION** (blocks Phase 4 Sepolia deploy of two-tier)
Source audit finding: `docs/remediation-plan.md` row M-6
Date: 2026-04-23

---

## The problem in one paragraph

Arbitova escrows are denominated in **USDC** (by design — stablecoin
for A2A commerce). Kleros v2 arbitration fees on Base are paid in
**ETH** (protocol requirement, not configurable). PNK (Kleros's own
token) is used for juror staking but not for fee payment. If the
appeal bond is USDC, the contract must swap some USDC to ETH at
appeal time to pay Kleros, which opens a price-slippage exposure. If
the bond is ETH, the appellant must hold ETH (an extra asset A2A
agents don't naturally carry) — friction at the moment we most want
to encourage legitimate appeals. If we get this wrong, we either
absorb silent FX loss onto the protocol treasury or we choke off
appeal volume at the currency-mismatch step. It's a small-surface
decision with durable consequences because it bakes into the
contract ABI.

---

## Three options

### (a) ETH bond (matches Kleros native fee)

Appeal bond is posted in ETH. Contract forwards the bond directly
to Kleros; any excess (bond > Kleros fee) is held in escrow and
refunded/forfeited per the D-1 bond-refund logic.

**Pros:**
- Zero FX risk at protocol level. What we receive equals what we
  forward.
- Smallest contract surface — no DEX integration, no slippage
  checks, no oracle dependency.
- Matches Kleros's own expectations. If anything goes weird
  on the Kleros side, we're using their canonical flow.
- ETH is the most liquid asset on Base. Any agent with a wallet
  can acquire it.

**Cons:**
- Agent friction: A2A agents built for stablecoin commerce may
  not hold ETH. They'd have to swap USDC → ETH just to post a
  bond, which is exactly the friction Arbitova's USDC-native
  pitch exists to eliminate.
- User-facing UX: "the escrow is in USDC but the appeal bond is
  in ETH" is genuinely confusing and generates support tickets.
- Volatility: an agent who posts a $72 ETH bond and waits 7 days
  for Kleros resolution is exposed to ETH price movement during
  the appeal. If ETH drops 10%, the refund (on reversal) is
  worth 10% less in USD terms.

---

### (b) USDC bond with internal DEX hop to ETH at appeal time

Appeal bond is posted in USDC. When the contract calls Kleros, it
performs an on-chain swap (Uniswap V3 USDC→WETH, or a quoted swap
via a paymaster) to acquire enough ETH to pay the Kleros fee. The
USDC → ETH swap happens inside the `appeal()` transaction.

**Pros:**
- Agent-facing UX is consistent: everything is USDC.
- Matches the USDC-native brand promise.
- Appellant is not exposed to ETH volatility during the appeal
  window (USDC is stable).

**Cons:**
- **Slippage risk is real.** USDC→ETH on Base via Uniswap V3 is
  liquid at normal volumes, but a thin-liquidity moment (chain
  congestion, USDC depeg event, bridge attack) can cause the
  swap to revert or fill at a bad price. If the swap reverts,
  the `appeal()` call reverts and the appellant can't appeal
  at all.
- Contract surface grows: we now depend on a DEX router ABI, a
  slippage-bound parameter, and a revert-handling path. Each is
  an audit item.
- **Silent treasury exposure:** if the slippage buffer is set
  at, say, 1% and a swap consistently fills at 0.5% slippage,
  the contract accumulates a small USDC surplus per appeal.
  That's fine. But if slippage ever exceeds 1% during a
  congestion event, the swap reverts — and the appellant now
  has to resubmit at a worse quote, bearing that cost. Worst
  case: appeals become unreliable during exactly the moments
  of market stress when they matter most.
- MEV exposure on the USDC→ETH leg. Each appeal is a
  sandwichable trade if not routed through private orderflow.

---

### (c) Native Arbitova token bond (ARBI or similar)

Appeal bond is posted in a native token (not yet issued). Kleros
fee is still paid in ETH; the contract handles the ARBI→ETH path
via treasury-managed reserves.

**Pros:**
- Strongest alignment between appeal participants and protocol
  long-term health.
- Creates a buy-pressure flywheel if the token has genuine
  utility.

**Cons:**
- **Not available.** Arbitova has no token, no issuance plan,
  and no plan to issue one in 2026. Ship blocker.
- Regulatory risk category we're actively avoiding. A token
  used to access protocol dispute resolution is the textbook
  "security with utility veneer" shape — exactly what we said
  we wouldn't do.
- Forces us to become a token-ecosystem play. That's a full
  pivot, not a bond-currency decision.

This option is listed for completeness and for symmetry with the
remediation plan's three-option framing. **It is not actually on
the table for 2026.**

---

## Recommendation

**(a) ETH bond, with an SDK helper that quotes a USDC→ETH swap just
for the bond amount.**

Concretely:

1. The contract accepts the bond in ETH (`appeal(id)` is `payable`,
   requires `msg.value >= bondAmount`). Contract surface stays
   minimal; Kleros fee path is direct.
2. The JS/Python SDK ships a helper:
   `sdk.quoteAppealBondInUsdc(disputeId) → { bondEth, bondUsdc, route }`.
   The helper returns a live Uniswap V3 quote for exactly the
   bond amount plus 0.5% slippage, and a pre-signed transaction
   bundle that performs the swap and the appeal in one submission
   (via a smart-account or bundler flow).
3. The docs say plainly: "Appeal bond is ETH. The SDK helper
   handles USDC→ETH conversion for you if your agent only holds
   USDC. If you prefer to control the swap yourself, the raw ETH
   amount is returned from `quoteAppealBond`."

Reasoning:

- **(a) minimizes contract risk.** Every line of Solidity in the
  appeal path is a line Kleros already understands how to interact
  with. No DEX adapter, no slippage disaster during congestion.
- **(b) pushes the problem to the wrong layer.** DEX-hop inside
  the contract means every appeal is a front-run target and every
  illiquidity moment is an appeal outage. The protocol should not
  own that risk; the appellant's wallet tooling should.
- **(a) + SDK helper is (b)'s UX with (a)'s safety.** The agent
  developer sees "call `sdk.appeal()`, we handle the USDC→ETH
  for you." Under the hood, the swap happens in the appellant's
  wallet (or via a paymaster they chose), not inside our
  contract. Slippage failures manifest as "your swap failed,
  retry" — which is recoverable — instead of "the protocol
  reverted your appeal" — which is not.
- **(c) is off the table.** No token, no plan for a token, and
  we've publicly said we're not a token play.

**Why not hybrid (accept either ETH or USDC, convert internally
only if USDC)?** Because it doubles the contract branch
(two appeal code paths, two refund paths) and the "only if
USDC" branch inherits all the (b) slippage risks. The SDK-helper
approach gives us the UX win without the contract complexity.

---

## Decision record

- [ ] Founder choice: ______  (a / b / c)
- [ ] Date: ______
- [ ] Rationale if different from recommendation: ______
- [ ] Follow-up: if (a), implement `quoteAppealBondInUsdc` helper in
  `packages/sdk-js/src/pathB.js` and `packages/sdk-python/arbitova/path_b.py`
- [ ] Follow-up: update `two-tier-arbitration-design.md` to specify
  ETH-denominated bond and document the SDK helper
- [ ] Follow-up: add a docs page `docs/appeal-bond-currency.md`
  explaining the ETH-vs-USDC rationale for SDK users who will
  ask why the currencies don't match
