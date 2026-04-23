# ERC-4337 Session Keys for Arbitova — Design Doc (v0.1)

Status: design draft, no implementation yet.
Author: Arbitova / 2026-04-23.
Scope: signer-side infrastructure for agents paying via Arbitova.
This doc does not propose contract changes to `EscrowV1`.

---

## The problem

Today an Arbitova-using agent needs:

1. An externally owned account (EOA).
2. Its private key, in process memory, for signing.
3. Enough Base Sepolia ETH to pay gas.
4. Enough USDC to fund the escrow.

(1) and (2) are fine for a single long-running agent run by an
operator who already has wallet infrastructure. They're a cliff for
a spawning pattern where a parent agent wants to spin up children
for specific tasks and shut them down. Each child needs its own EOA
and someone has to top it up with ETH.

ERC-4337 (Account Abstraction) + **session keys** offer a cleaner
shape: the parent holds a smart account; children are given *scoped,
expiring* signing permissions (session keys) that can call specific
methods on specific contracts within a budget. No per-child EOA.
Gas is paid by a Paymaster, funded by the parent.

## Scope of v0.1

- Parent smart account: a single ERC-4337 account (SimpleAccount or
  Kernel) owned by the user's root wallet.
- Session key permissions: a child key can call
  `EscrowV1.createEscrow`, `markDelivered`, `confirmDelivery`,
  `dispute`, `cancelIfNotDelivered`, **and** `USDC.approve` on a
  single seller, up to a capped amount, before a fixed expiry.
- Bundler/Paymaster: Pimlico on Base Sepolia. Arbitova does not run
  infrastructure — we consume existing bundler/paymaster services.
- Target language: TypeScript (`packages/session-keys/`) with a thin
  Python wrapper (`python-sdk/arbitova/session_keys.py`) exposing
  permission-grant + key-issue primitives.

## Out of scope

- Mainnet. Base Sepolia only for v0.1.
- Cross-chain session keys. Session keys are chain-specific.
- Custom paymaster pricing. Use whatever Pimlico or Alchemy exposes.
- Rotating bundler providers automatically. Pick one, document the
  failure mode, move on.

## Permission model

A session key grants the child:

```
contract:  EscrowV1 (0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC)
methods:   createEscrow, markDelivered, confirmDelivery,
           dispute, cancelIfNotDelivered
expires:   <unix timestamp, parent-chosen, capped at 24h>
value cap: <max USDC the child can lock cumulatively>
scope:     optional seller allowlist (addresses only)
```

Plus one paired grant on USDC:

```
contract:  USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
methods:   approve
spender:   must be the Escrow contract above
value cap: <same cumulative USDC cap>
expires:   <same timestamp>
```

Pairing is important: without the USDC `approve` grant the escrow
calls will fail; without the cumulative cap a child can drain the
parent's balance if the parent mints a session key per escrow but
forgets to revoke.

## v0.1 deliverables

- `packages/session-keys/` — TypeScript package.
  - `issueSessionKey(parentAccount, spec)` — builds the permissions
    payload and signs a delegation userOp.
  - `useSessionKey(sessionKey, escrowCall)` — builds a userOp for
    the child call, sent via Pimlico bundler.
  - Tests against a local Anvil fork of Base Sepolia with a stubbed
    bundler.
- `python-sdk/arbitova/session_keys.py` — thin wrapper over the TS
  package's REST surface (TBD) OR a native implementation using
  `web3.py` + eth_account. Decide in v0.1 alpha.
- `examples/path_b/session_key_demo.{js,py}` — parent spawns child,
  child creates + confirms an escrow, parent revokes.
- `docs/session-keys-api.md` — developer-facing API doc once v0.1
  alpha code stabilizes.

## Known risks

- **Bundler dependency.** Session-key userOps require a bundler.
  If Pimlico / Alchemy has an outage, the whole agent flow stops.
  Acceptable for v0.1 because the contract still works direct; the
  session-key path is an opt-in convenience, not a requirement.
- **ERC-4337 mempool liveness.** userOps can be dropped. Retries
  must be idempotent — `createEscrow` is not idempotent (creates a
  new id each time), so retries need a nonce-aware design or a
  dedup layer keyed by `verificationURI`.
- **Paymaster sponsorship fraud.** A child with a session key can
  spam low-value escrows and burn the parent's gas budget at the
  Paymaster. Mitigation: gas budget cap alongside USDC cap. Ship
  both.

## Open questions

1. **Library choice.** Alchemy Account Kit, ZeroDev Kernel, or
   Pimlico's permissionless.js? All three ship session-key
   primitives. Preference for whichever has the leanest TypeScript
   surface; bring whoever ships the cleanest `issuePermissions` API.
2. **Session key storage.** Where does the child *hold* its session
   key? In-memory only for v0.1. A future version might let the
   parent grant a session key tied to an existing EOA so the child
   doesn't need to generate its own.
3. **Revocation latency.** Most 4337 implementations revoke via an
   on-chain tx. Gap between "parent decides to revoke" and "session
   key is actually invalid" is one block (~2s on Base). Good enough
   for v0.1; document it.

## What shipping this unlocks

- The CDP adapter (`arbitova.cdp_adapter`) is one answer to "how
  does an agent sign without its own key." Session keys are a
  second, complementary answer — one for operators who prefer their
  own smart account over a CDP-managed one.
- The x402-adapter (`@arbitova/x402-adapter`) becomes usable inside
  spawned children with no per-child wallet setup.
- LangGraph flows can spawn per-task agents that each have a
  bounded budget and auto-expiring signing rights. That's the
  actual agent-economy shape.

## Next steps

Not yet started. Next concrete step: pick the 4337 library (tracked
as open question 1). Decision owed after a ~2h spike comparing
Alchemy Account Kit vs ZeroDev Kernel on session-key ergonomics.
