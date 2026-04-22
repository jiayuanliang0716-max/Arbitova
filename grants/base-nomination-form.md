# Base Builder Grants — Nomination Form Answers

**Source form:** https://docs.google.com/forms/d/e/1FAIpQLSfXuEzmiAzRhie_z9raFCF1BXweXgVt18o-DvBuRRgyTygL2A/viewform
**Nomination URL comes from:** https://paragraph.com/@grants.base.eth/calling-based-builders
**Program structure:** retroactive, 1–5 ETH per recipient, nomination is supplementary to Base team's own discovery process — response not guaranteed.

---

## Field-by-field answers

### 1. Email (required)
`jiayuanliang0716@gmail.com`

### 2. Nominator Name (required)
`Jia-Yuan Liang` (self-nomination)

### 3. Project Name (required)
`Arbitova`

### 4. Project URL (required)
`https://arbitova.com`

### 5. Project Twitter (required)
**⚠️ GAP** — Arbitova X/Twitter account not yet created. Listed in `project_arbitova_pending_user_actions.md` as an outstanding user task.
*Fallback if account not created by submission time:* leave the GitHub URL `https://github.com/jiayuanliang0716-max/Arbitova` and note in body that Twitter is coming.

### 6. Project Farcaster/Channel (required)
**⚠️ GAP** — no Farcaster channel yet. Needs to be created on warpcast.com (free, 5-minute signup).
*Fallback:* leave blank or write "not yet created — will add upon funding".

### 7. Builder Twitter (required)
**⚠️ GAP** — user's personal X/Twitter handle, not previously collected.
*Needed from user:* the handle to list here.

### 8. Builder Farcaster (required)
**⚠️ GAP** — same issue.

### 9. Is the project currently live on Base? (required, multiple choice)
**Answer: `No - live on Base testnet`**
(Currently `EscrowV1` deployed and verified on Base Sepolia at `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC`. Mainnet gated on four items: external audit, multisig arbiter, on-chain arbiter registry, one-week zero-drift indexer.)

### 10. Why does this project deserve a Base grant? (required, max 150 words)

**Drafted answer (147 words):**

> Every A2A spec — MCP, Google A2A, ERC-7683 — defines how agents talk. None define how money moves when agents don't trust each other. Arbitova is that missing layer: a non-custodial USDC escrow on Base with framework-agnostic arbitration. `EscrowV1` is deployed and verified on Sepolia, 66/66 Foundry tests passing, two end-to-end flows proven on-chain (happy path + 70/30 dispute resolve). Three reference demos — Claude Agent SDK, LangGraph, CrewAI — all hit the same contract through the same six calls.
>
> Shipped in public as a solo builder over 14 dev logs. I pivoted away from a custodial implementation last week because the weakest link was me; the contract is the whole product now. 0.5% fee on release, 2% on arbitration, no subscription, no tier.
>
> A grant accelerates external audit, unblocks mainnet, and funds ten more framework integrations.

### 11. Project Demo Link (required — 1-minute demo)
**⚠️ GAP** — no 1-minute demo video exists yet.
*Candidate content to film (screen-record):*
- Open `https://arbitova.com/pay`
- Connect wallet (Sepolia), fund
- Create escrow → mark delivered (show content hash) → confirm OR dispute → resolve
- Show tx hashes on Basescan
- End card with repo + npm install one-liner

*Fallback if no time to film:* paste the live Basescan tx links for escrow #5 (release) and #6 (resolve) — less ideal, but shows the protocol actually works on-chain.

### 12. Multimedia Rights Confirmation (required checkbox)
Check ✔ — Coinbase wants to quote/feature grantees on their channels; no reason to decline.

### 13. Marketing Communications Opt-in (required checkbox)
Check ✔ — receiving Base ecosystem comms is useful.

---

## What the user needs to provide before this can be submitted

**Hard blockers (form won't accept without):**
1. Builder Twitter handle (user's personal)
2. Builder Farcaster handle (user needs to create warpcast account if none)
3. Project Twitter — either create `@arbitova` on X, or accept the fallback
4. Project Farcaster channel — create a `/arbitova` channel on Warpcast
5. 1-minute demo link — either record a screencap (~20 min of work) or accept Basescan fallback

**What I've already handled:**
- Email, nominator name, project name, project URL → done
- Live-on-Base answer → done (testnet)
- 150-word pitch → drafted to 147 words
- Multimedia + marketing checkboxes → defaults set

---

## Submission recommendation

**Don't submit yet.** Base explicitly says "we won't respond to most requests and will only reach out if selected" — meaning one shot per project. Submitting with 3 blank Farcaster/Twitter fields and no demo video signals "not ready" and wastes the attempt.

**Checklist before submitting:**
- [ ] User provides personal Twitter + Farcaster handles
- [ ] Arbitova X account created (or accept the fallback answer)
- [ ] Arbitova Farcaster channel created on Warpcast
- [ ] 1-minute demo recorded and uploaded (YouTube unlisted or Loom)
- [ ] M1 metrics refreshed — if any traction number materially improves before submission, update the 150-word pitch to cite it

**When all above are green, submission itself is a 5-minute paste job.** I'll do the paste once the user clears the blockers.
