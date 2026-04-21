# Base Builder Grant Application — Arbitova

**Applicant:** Jia-Yuan Liang (solo builder)
**Project:** Arbitova — the A2A escrow standard on Base
**Amount requested:** 5 ETH (retroactive + 90-day milestone track)
**Status:** live on Base Sepolia, mainnet gated on 4 security items
**Links:**
- Live UI: https://arbitova.com
- Deployed contract (Sepolia): `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`
- Source: https://github.com/jiayuanliang0716-max/Arbitova
- RFC draft: https://github.com/jiayuanliang0716-max/Arbitova/blob/master/spec/A2A-ESCROW-RFC-v0.1.md
- SDK: https://www.npmjs.com/package/@arbitova/sdk

---

## 1. What Arbitova is

Arbitova is an on-chain escrow + arbitration primitive for **agent-to-agent (A2A) commerce**. Two agents — human-owned or autonomous — lock USDC into a contract, one delivers, the other confirms or disputes, and a neutral arbiter resolves disputes with a signed verdict. The contract (`EscrowV1`) is non-custodial: funds only move when the state machine allows, and the protocol takes 0.5% on clean release / 2% on arbitration.

It is **not** a marketplace. It is not a subscription product. It is a single-purpose settlement primitive, published as:

1. A deployed contract on Base.
2. An open `@arbitova/sdk` (ethers, ESM, MIT).
3. A public RFC (`spec/A2A-ESCROW-RFC-v0.1.md`) that any competing implementation can fork.
4. A reference UI at `arbitova.com` that anyone can use without an account.

Why this matters: Google's A2A spec, Anthropic's MCP, and ERC-7683 all assume that agents can transact — but none of them specify *how money moves when the agents don't trust each other*. Arbitova fills that gap with a single contract and a public standard.

## 2. Why Base

- USDC on Base is the single most-liquid stable for low-fee settlement among L2s. A 0.5% escrow fee on a $20 agent transaction is $0.10 — which only works on a chain where gas is sub-cent.
- Coinbase's A2A commerce thesis (Commerce Payments Protocol, Coinbase Agent Commerce) is the closest institutional peer to what this RFC defines. Standardizing Arbitova on Base makes the two compatible by default.
- `Base Sepolia` public RPC (`https://sepolia.base.org`) and OnchainKit have already been enough to ship the full Sepolia deployment solo.

## 3. What already exists (retroactive portion — 2 ETH)

Delivered between 2026-04-18 and 2026-04-22, solo:

| Artifact | Status |
|---|---|
| `EscrowV1` contract, 6 entrypoints, 6 events, pull-payment arbiter | Deployed on Sepolia, 66/66 tests green, TOCTOU-hardened |
| Non-custodial web UI (buyer / seller / arbiter / public lookup / verdict log) | Live at arbitova.com |
| `@arbitova/sdk` v3.0.0 (ethers-based, read + write + event subscribers) | Published on npm |
| A2A Escrow RFC v0.1 | In repo, public |
| Three reference A2A integrations (Claude Agent SDK, LangGraph, CrewAI) | All end-to-end on Sepolia |
| Daily reconcile cron (balance drift detector) | Running on Render |
| Dev Logs #001–#014 | Public on GitHub |

## 4. What the 90-day plan buys (forward portion — 3 ETH milestone-based)

**Milestone A — Standard (week 1–4, 1 ETH).** Ship RFC v1.0: finalize the `verificationURI` schema, add a conformance test suite that any alternate implementation can run against, publish ten integration tutorials (Claude / OpenAI / LangChain / CrewAI / Google ADK / plus five mini-agent recipes). Success = 3 external forks of the spec, 100+ GitHub stars, RFC linked from at least one agent-framework doc site.

**Milestone B — Base mainnet gate (week 5–9, 1 ETH).** Close the four remaining mainnet-gate items: (1) third-party audit (Cantina or Sherlock, not just my tests), (2) rotate ADMIN_KEY to a multisig, (3) migrate arbiter allow-list to an on-chain registry, (4) deploy on Base mainnet with `0.5% / 2%` fee splits live. Success = one real mainnet transaction end-to-end.

**Milestone C — First paying A2A flow (week 10–13, 1 ETH).** Ship one production integration: an agent-to-agent marketplace or a Base-native service using Arbitova as its settlement layer, generating fee revenue in USDC. Success = ≥100 mainnet escrows, ≥$10K notional settled, ≥1 arbitration with a signed verdict on-chain.

Each milestone releases on merged PR + public Dev Log + on-chain receipt. No milestone = no disbursement.

## 5. Why me, solo

I've gone from zero to a deployed, tested, documented non-custodial escrow on Base Sepolia in five days while also shipping the SDK, the spec, three framework integrations, and a working reference UI. This grant extends runway to do the part I cannot self-fund: the external audit and mainnet deploy gate. Everything else I can keep shipping at current pace.

## 6. Risks and how they're handled

- **Audit finds critical.** Fix + re-audit before mainnet. Mainnet deploy is gated on passing audit — no shortcut.
- **No one adopts the RFC.** Falls back to being a strong single-implementation product on Base. Still useful, still revenue-generating, just not "standard."
- **Arbiter collusion.** Verdicts are RFC-8785-canonicalized + keccak256 signed; arbiter allow-list is on-chain and rotatable. Long-term: stake-based slashing, out of scope for v1.
- **Regulatory.** Non-custodial design means Arbitova never holds user funds off-chain; fees are contract-level. Legal review before mainnet is in Milestone B.

## 7. Grant reporting cadence

Weekly public Dev Log on GitHub, same format as the existing 14. Monthly on-chain fee report (generated by the existing reconcile cron). All grant funds tracked in a dedicated Base address, published in the repo README.

---

*Contact: jiayuanliang0716@gmail.com · Farcaster: @arbitova · Repo: github.com/jiayuanliang0716-max/Arbitova*
