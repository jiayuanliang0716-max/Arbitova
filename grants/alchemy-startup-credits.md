# Alchemy Startup Credits Application — Arbitova

**Applicant:** Jia-Yuan Liang (solo builder, Taiwan)
**Project:** Arbitova — on-chain escrow + arbitration for agent-to-agent (A2A) commerce
**Chain:** Base (Sepolia live; mainnet gated on audit)
**Credits requested:** Alchemy Startup tier, 12 months
**Current RPC usage:** ~5k Sepolia requests/day (public RPC); expected to spike 10–100× on mainnet launch

---

## 1. What we're building

Arbitova is a non-custodial USDC escrow contract (`EscrowV1`) on Base. Two agents — human- or LLM-controlled — lock funds, one delivers, the other confirms or disputes, and an allow-listed arbiter resolves disputes. 0.5% fee on clean release, 2% on arbitration.

The SDK (`@arbitova/sdk` v3.0.0 on npm), reference UI (`arbitova.com`), and public RFC (`A2A-ESCROW-RFC-v0.1`) are all MIT-licensed and open on GitHub. Three framework integrations (Claude Agent SDK, LangGraph, CrewAI) already ship as end-to-end demos.

## 2. Why we need Alchemy specifically

- **Historical event queries.** `/verdicts` and `/status` pages walk the full `DeliveryConfirmed`, `EscrowDisputed`, and `DisputeResolved` event log. Base public RPC caps at 10k blocks per `eth_getLogs` — workable on Sepolia, unworkable on mainnet at any volume. Alchemy's 2k block + archive support fixes this.
- **Webhooks for state transitions.** Every escrow emits 1–4 events. Current architecture polls; Alchemy's Address Activity webhooks would let us push notifications to buyer/seller inboxes in real time without a separate indexer.
- **Enhanced APIs.** `getAssetTransfers` lets us show users their cumulative USDC fee contribution to the protocol — a UX we want for transparency. Not possible on vanilla JSON-RPC.
- **Reliability.** Public RPC is best-effort. Mainnet settlement cannot be best-effort. When a buyer clicks "Confirm delivery" they need the tx to land on first submission, not the fifth.

## 3. Traction so far

- Deployed contract on Base Sepolia: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`
- 66/66 contract tests green, TOCTOU hardened
- SDK published on npm
- RFC v0.1 in the open
- Three live A2A framework demos
- Daily reconcile cron running on Render (ledger ↔ on-chain balance diff)
- 14 public Dev Logs since 2026-04-08

## 4. Expected usage (12 months, rough)

| Phase | Timeline | eth_calls/day | eth_getLogs/day | Webhook events/day |
|---|---|---|---|---|
| Sepolia now | today | 5k | 100 | 0 |
| Mainnet soft-launch | month 2 | 20k | 500 | 200 |
| First integration live | month 4 | 80k | 2k | 2k |
| 10-integration target | month 8 | 300k | 8k | 15k |
| Steady state | month 12 | 1M | 30k | 50k |

These are order-of-magnitude estimates from projected escrow volume, not precise traffic forecasts.

## 5. What credits buy us

- **Month 1–3:** migrate `arbitova.com` front-end RPC from public Base Sepolia to Alchemy. Rewire `/verdicts`, `/status`, event subscriptions. Ship Alchemy Webhooks instead of polling.
- **Month 4–6:** mainnet launch, 24/7 arbiter agent hot-swap, archive node for dispute replay.
- **Month 7–12:** scale to 10 integrations without rewriting the RPC layer.

We expect to graduate to paid Growth tier by month 6 if mainnet volume hits the Phase 3 projection.

## 6. What we give back

- **Alchemy shout-outs** in the Dev Log, README, and every integration tutorial (we're writing 10).
- **Case study** at month 6 on real A2A settlement volume on Base, co-branded if Alchemy wants.
- **Open benchmarks:** we'll publish p50/p95 latency and reliability stats for Alchemy vs public RPC as part of our transparency reports.
- **Spec adoption:** the RFC references specific RPC behaviors (e.g., chunked `getLogs`) — Alchemy is well-positioned to be the reference provider.

## 7. Team / contact

- **Builder:** Jia-Yuan Liang (solo). Background in manufacturing internal-systems engineering, pivoting to remote web3 infra.
- **Email:** jiayuanliang0716@gmail.com
- **Repo:** github.com/jiayuanliang0716-max/Arbitova
- **Deployed contract (to whitelist for Alchemy Webhooks):** `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` on Base Sepolia

---

*Submitted 2026-04-22.*
