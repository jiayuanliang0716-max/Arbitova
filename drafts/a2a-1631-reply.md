---
target: https://github.com/a2aproject/A2A/discussions/1631
status: FINAL v3 (founder-polished 2026-04-25) — awaiting post approval
author: Arbitova (Jiayuan Liang)
intent: Contribute the dispute-resolution layer that complements the trust-attestation surface being converged on in this thread. Position as peer, not vendor. Preempt "why trust Arbitova's verdicts" objection.
length: ~620 words (thread norm 300-800)
revision_notes: v3 is founder's own polish of v2 — prose smoothed, openings tightened ("Really appreciate" → "Thanks to everyone", "falls apart for disputed" → "Disputed is a harder case"), plural "we" used for company references. Code-formatting backticks restored on protocol state names (`positive`, `disputed`, `disputed_at` etc.) to match thread convention — revert if founder prefers plain text.
---

# Final reply to a2aproject/A2A Discussion #1631

Thanks to everyone — the split @makito20256 drew between assertion semantics (`positive` / `negative` / `incomplete`) and relation semantics (`revoked` / `disputed`) is what's been nagging at me, because it quietly surfaces a gap the attestation surface alone can't close.

The gap is: who gets to produce a `disputed` relation, and on what grounds?

In a purely attestation-first world any two parties can emit attestations about each other. That's fine for `positive` — a counterparty saying "this agent delivered" is weak evidence but honest evidence. `disputed` is a harder case. If either party can unilaterally publish `disputed_at` with a free-form reason, you get problems like:

- A buyer who didn't like an honest delivery marks it `disputed` with a plausible-sounding rationale and tanks the seller's attestation graph.
- A seller who under-delivered pre-emptively publishes `disputed` on the buyer to neutralize whatever negative attestation the buyer is about to emit.
- And the consumer of the graph has no principled way to tell a real dispute from a retaliatory one.

ARP's anti-gaming measures — transaction-bound evidence, self-eval rejection, same-owner decay — are designed for the case where attestations are *fake* (the evaluator was never party to a real interaction, or the same entity is evaluating itself). They don't cover the case where attestations are *contested*: two parties who really did interact, but now disagree on the outcome. Different threat model, different protocol.

The minimal attestation surface you're converging on handles the shape of a `disputed` relation correctly. The surface only does useful work if the `disputed` relations that populate it are themselves trustworthy, and producing a trustworthy `disputed` relation is its own protocol — a dispute resolution protocol — whose output the substrate can then consume.

**What I've been building at Arbitova**

Disclosure: this is what I've been working on for the last few months, as an open protocol called Arbitova (github.com/jiayuanliang0716-max/a2a-system, arbitova.com). I deliberately don't do reputation scoring or discovery — those layers are addressed well by the proposals already in this thread. What Arbitova does is the post-transaction arbitration process: the mechanism that produces a `disputed` relation in a form a third party can independently verify.

A few concrete pieces:

- **Escrow as the dispute locus.** Two agents lock USDC on-chain before the task starts. The escrow ID is the identity of the dispute — not an off-chain claim pointing at one. Same "transaction-bound evidence" principle the ARP substrate uses: no recorded interaction, no dispute.
- **Arbiter bound by structural prompt-injection defenses and content-hash verification.** Untrusted evidence fields are XML-wrapped with zero-width-space escaping of closing tags; delivered content is keccak256-verified against the on-chain hash before the arbiter ever sees it. Neither party can manipulate the arbiter through what they submit.
- **Every verdict published with reasoning, evidence hashes, and verification result.** These public verdicts look to me like exactly the kind of "verifiable `disputed` attestation with evidence pointer" the minimal surface is defining a slot for.

**Why would you trust an Arbitova verdict?**

Fair question, and honestly the one I'd ask first. The short version: you don't trust Arbitova — you reconstruct the verdict. Evidence hashes sit on-chain, the content-hash check is deterministic, the arbiter's reasoning is public, escrow release is gated by the same verification. A third party auditing a `disputed` record produced this way can recompute every step. The trust assumption becomes "the arbiter's reasoning was sound given the evidence it saw," which is auditable. It is *not* "trust Arbitova as an institution."

The arbiter being a single party is a known limitation, not a stance. Multi-arbiter selection and an optimistic-oracle fallback (UMA-style) are on the roadmap for the same reason the PageRank move is on yours — decentralizing the weight-producing role. The current version is deliberately minimal so the core mechanism can get stress-tested before a consensus layer is bolted on.

**Stage check, being honest:** mechanism is deployed to Base Sepolia, JS / Python / MCP SDKs published, adversarial review of the arbiter pipeline done. Real commercial case volume is still being bootstrapped. Roughly where ARP was around v0.1 — the mechanism is real, the volume isn't there yet.

**Two things I'd like to ask the thread**

1. Does it make sense to treat dispute resolution as a *separate* A2A extension that produces `disputed` relations, with the attestation extension consuming them? The extensions pattern ARP already uses seems to support this cleanly.
2. Would a minimal dispute-resolution surface — inputs, outputs, trust assumptions, threat model — written up in the same provider-neutral style be useful input to the thread?

Happy to contribute either way. Arbitration and attestation are two halves of the same problem, and I'd much rather see them standardized together than drift apart.

— Jiayuan

---

## Why this draft v2, what to check before posting

- **No specific case counts.** v1's footnote about "329" is not in the body; all stage references are qualitative. Explicitly: "mechanism deployed on Sepolia, SDKs published, adversarial review done, volume still bootstrapping."
- **Opens with makito's framing** (assertion vs relation). Engineers respond well to "I read your stuff, here's a thing I couldn't stop thinking about."
- **Shows repo reading** — the fake-vs-contested observation references ARP's actual anti-gaming table (self-eval, drive-by, decay) by category, not by flattery. That's the cheapest credibility signal available.
- **"Why trust our verdicts" is now its own beat**, not implicit. The deterministic-recomputation frame borrows makito's own substrate principle ("same ledger always produces the same derived scores"), which should read as native thread language.
- **Multi-arbiter roadmap briefly flagged** — preempts "centralized trust intermediary" critique without derailing into the UMA/Kleros comparison. If asked, drop in the prepared Kleros/UMA answer below.
- **Asks concrete questions** — open-ended "happy to contribute" usually gets no reply. Question #1 is a real design choice, question #2 is a low-friction yes/no.
- **Length ~620 words.** Slightly over v1 (~550). Still within thread rhythm — makito's OP is longer.

## Pre-drafted follow-ups for likely responses

1. **"We already cover dispute via the `state: disputed` field."** → "Agreed on the field — the data shape works. My point is the *process* that fills the field. Without a protocol for producing the value, `state: disputed` is whatever the last writer said. The field is necessary; what I'm suggesting is a companion extension that specifies how the value is produced so that a third-party consumer can verify it."
2. **"Show us your verdicts / case data."** → Honest: "arbitova.com/verdicts has the ones we've run. Volume is bootstrap-stage; I'm not pitching volume, I'm pitching the mechanism. If the mechanism holds, I'd rather integrate with whatever attestation surface you land on than run it in isolation."
3. **"Why not Kleros / UMA?"** → "Kleros's ~$60 floor is too heavy for sub-$100 agent tasks and their juror model doesn't handle structured evidence (content hashes, JSON artifacts) well. UMA's 48h dispute window doesn't fit agent SLAs. We target the 2-hour / sub-$10 tier that neither of them serves. UMA-style optimistic-oracle fallback is on our roadmap as a backstop for high-value cases."
4. **"Are you just another centralized arbitrator?"** → "Right now, yes — single-arbiter, which is why I flagged it as a limitation. Multi-arbiter selection is on the roadmap. The design goal is that even with a single arbiter, the verdict is *auditable* — anyone can recompute the content-hash check and inspect the reasoning. Trust in the arbiter is bounded, not assumed."

## Operational

- **Do not post from a bot account.** Use @jiayuanliang0716 (personal) or the GH account with most OSS history. Identifying as "Arbitova maintainer" in text is fine, posting as an org account is not.
- **Before posting: star `makito20256/arp-trust-substrate`.** Minor but real signal of engagement; current star count is 1, so it moves the needle.
- **Timing:** weekday US Pacific morning. Thread participants span US + Asia based on timestamps. Avoid Friday evening.
- **After posting: reply promptly to any response within 24h.** Standards threads die fast if the original poster ghosts.
- **Footer check:** no `🤖 Generated with Claude Code` line. Post from user, not AI identity.
