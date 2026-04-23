# Pimlico Paymaster Integration Plan (v0.1 draft)

Status: plan only, no implementation. Depends on
`docs/erc4337-session-keys-design.md` landing first (or at least
settling on a 4337 library).

---

## Purpose

Let agents pay Arbitova escrow transaction gas *without* holding ETH
on their signer. The Paymaster sponsors `UserOp` gas on Base
Sepolia, denominating sponsorship in USD via Pimlico's billing.

Without a paymaster, every agent needs ETH on Base before it can
call `createEscrow`. With a paymaster, the agent only needs USDC
for the escrow itself. This removes the biggest "how do I pre-fund
this wallet" cliff.

## What Pimlico provides

- A bundler that accepts 4337 UserOps and submits them to Base.
- A verifying Paymaster that, given an API key + sponsorship policy,
  attaches a signature to the UserOp letting the paymaster contract
  pay the gas.
- A dashboard for sponsorship budgets and per-operation limits.

Docs: https://docs.pimlico.io/ (user to verify current URLs at
integration time; do not hardcode these in shipping SDK copy).

## Scope of v0.1

Sponsorship policy on our Pimlico project:

- **Chain:** Base Sepolia only.
- **Allowed target contracts:**
  - EscrowV1 (`0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`)
  - Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`,
    `approve` only, spender must be EscrowV1)
- **Per-operation gas ceiling:** 600k gas (covers our most
  expensive method `escalateIfExpired` with headroom).
- **Per-day total ceiling:** $X/day (user decides; Pimlico UI
  setting, not a code change).
- **No sponsored transfers.** We sponsor escrow lifecycle + the
  paired `approve`, nothing else. Any other `to` fails policy.

## v0.1 deliverables

- `.env.example` updates: `PIMLICO_API_KEY`, `PIMLICO_BUNDLER_URL`,
  `PIMLICO_PAYMASTER_URL`. No secrets committed.
- Client-side helper `packages/session-keys/src/paymaster.ts`:

  ```ts
  export function withPimlicoPaymaster(userOp, opts: {
    apiKey: string;
    paymasterUrl: string;
  }): Promise<UserOperation>;
  ```

  Takes a built UserOp, returns one signed by the paymaster ready
  to send to the bundler.
- Integration in `useSessionKey()` (from session-keys design doc):
  if `opts.paymaster` is configured, route through paymaster;
  otherwise require the signer to have ETH and pay its own gas.
- A Sepolia smoke script that runs `createEscrow` → `confirmDelivery`
  start-to-finish with only USDC in the signer wallet and no ETH.

## What this does NOT give us

- **Mainnet sponsorship.** Separate Pimlico project, separate
  billing, separate policy. Gated on mainnet audit + multisig
  arbiter.
- **Anonymous agents.** The sponsor (us) pays gas. Pimlico sees
  everything. If the user wants unsponsored mode, they opt out and
  fund their own ETH.
- **Outage tolerance.** If Pimlico is down, sponsored UserOps fail.
  The contract still works direct; paymaster is convenience, not
  correctness.

## Costs

Pimlico sponsorship pricing varies; confirm at integration time.
Expected ballpark on Base Sepolia:

- `approve`: ~50k gas × base fee → sub-cent
- `createEscrow`: ~250k gas → sub-cent
- `confirmDelivery` / `dispute`: ~150–200k gas → sub-cent
- Full round trip per escrow: ~500k gas sponsored.

Sepolia is testnet, so actual cost is near-zero for our v0.1 testing
budget. Mainnet would be meaningfully different and is scoped out.

## Security notes

- Paymaster API key is a **server-side** secret. Never ship in
  client SDK or browser. Clients should call an Arbitova-operated
  endpoint that proxies paymaster signing, OR developers provide
  their own Pimlico project key.
- Sponsorship policy must deny arbitrary `to` addresses. A
  misconfigured policy could let an attacker drain our Pimlico
  budget by issuing UserOps to nonsense contracts.
- Daily budget cap is the last-line defense. Even with policy
  errors, a capped budget limits blast radius to $X.

## Open questions

1. **Do we proxy the paymaster or expect users to bring their own?**
   Proxy is friendlier; bring-your-own is more decentralization-
   consistent. v0.1 alpha: offer both, default to bring-your-own
   so we don't accidentally become a custody point for budgets.
2. **Paymaster during dispute resolution.** When the arbiter
   calls `resolve`, should it be paymaster-sponsored or should the
   arbiter have its own ETH? Suggest: arbiter pays its own gas.
   Keeps paymaster exposure to user-initiated calls only.
3. **ERC-20 paymasters.** Pimlico also offers paymasters that
   accept USDC for gas payment. Worth a v0.2 look — removes ETH
   dependency entirely for everyone, not just sponsored users.

## Sequencing

This plan is explicitly downstream of the session-keys design doc.
Order of work:

1. Decide 4337 library (see erc4337-session-keys-design.md open
   question 1).
2. Ship session-keys v0.1 alpha.
3. Add paymaster as an opt-in flag on the session-keys helper.
4. Ship the "no ETH needed" Sepolia smoke as a public demo /
   dev log entry.
