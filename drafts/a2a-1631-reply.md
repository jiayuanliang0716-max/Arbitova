---
target: https://github.com/a2aproject/A2A/discussions/1631
status: DRAFT — do not post without founder review
author: Arbitova (Jiayuan Liang)
intent: Contribute the dispute-resolution layer that complements the trust-attestation surface being converged on in this thread. Position as peer, not vendor.
length: ~550 words (thread norm is 300-800)
---

# Draft reply to a2aproject/A2A Discussion #1631

Really appreciate the shape this thread has taken — the distinction between assertion semantics (`positive` / `negative` / `incomplete`) and relation semantics (`revoked` / `disputed`) that @makito20256 drew is the thing I keep coming back to, because it surfaces a subtle issue that a pure attestation surface can't answer on its own.

**The issue: who gets to produce a `disputed` relation, and on what basis?**

In a purely attestation-first world, any two parties can emit attestations about each other. That works fine for `positive` — a counterparty saying "this agent delivered" is weak evidence but honest evidence. It falls apart for `disputed`. If either party can unilaterally publish `disputed_at` with a free-form reason, then:

1. A buyer who didn't like an honest delivery can tank a seller's attestation graph by marking it `disputed` with a plausible-sounding rationale.
2. A seller who delivered garbage can pre-emptively publish `disputed` on the buyer to counter any negative attestation the buyer makes.
3. Consumers of the attestation graph have no way to distinguish "real dispute with evidence" from "retaliatory dispute with fabricated evidence."

The minimal attestation surface you're converging on handles the *data shape* of dispute correctly. But the surface is only useful if the `disputed` relations that populate it are themselves *trustworthy*, and that's a separate protocol — a dispute resolution protocol — not an attestation protocol.

**What we've been building at Arbitova**

Disclosure: I've been working on exactly this problem for the last few months as an open protocol called Arbitova (github.com/jiayuanliang0716-max/a2a-system, arbitova.com). Very deliberately it does *not* do reputation scoring or discovery — those layers are addressed well by the proposals in this thread. What it does is the post-transaction arbitration process: the mechanism by which a `disputed` relation gets produced in a way that an independent consumer can trust.

Concretely:

- **Escrow as dispute locus.** Two agents lock USDC on-chain before the task. The escrow ID is the identity of the dispute, not an off-chain claim.
- **Arbiter bound by structural prompt-injection defenses + content-hash verification of the delivery artifact.** The arbiter can't be manipulated by either party through the evidence they submit (any untrusted field is XML-wrapped with zero-width-space escaping of closing tags; delivery content is keccak256-verified against the on-chain hash before the arbiter ever sees it).
- **Every verdict published publicly with reasoning, evidence hashes, and the content-hash verification result.** These public verdicts are exactly the kind of "verifiable `disputed` attestation with evidence pointer" the minimal surface is defining a slot for.

Stage check (being honest): mechanism is deployed to Base Sepolia, SDKs published (JS/Python/MCP), adversarial review of the arbiter pipeline is done. Real commercial case volume is still being bootstrapped — we're roughly at the stage ARP was when @makito20256 published v0.1. I mention this because I don't want to oversell, only to flag that the design is real.

**What I'd like to ask the thread**

1. Does it make sense for the dispute-resolution layer to be a *separate* A2A extension that produces the `disputed` relations, with the attestation extension consuming them? Or is there a cleaner composition I'm missing?
2. Would it be useful for me to write up a minimal dispute-resolution surface (inputs, outputs, trust properties) in the same provider-neutral style, to see where it composes with what's converging here?

Happy to contribute either way. The arbitration layer and the attestation layer solve different halves of the same problem, and I'd rather it be standardized together than drift apart.

— Jiayuan

---

## Why this draft, what to check before posting

- **Doesn't claim 329 cases** — the other Claude inflated this. We cite honest stage ("roughly where ARP was at v0.1").
- **Opens with their own framing** (makito's assertion vs relation distinction). Engineers respond well to "I read your stuff and here's a thing I couldn't stop thinking about."
- **Gives them the gap on a plate** — the unilateral `disputed` problem. This is real and unsolved in the thread; once stated, it's obvious in retrospect. That's a good contribution shape.
- **Positions Arbitova as complementary, not competing** — "reputation, discovery: you. dispute resolution: us." No one has claimed the dispute layer. If we can anchor it while nobody else wants it, Arbitova becomes the default reference implementation for the dispute half of A2A trust.
- **Asks a concrete question** at the end so the thread has something to respond to. Open-ended "happy to contribute" usually gets no reply.
- **Length:** ~550 words. Shorter than makito's OP, longer than balthazar's latency comment. Fits the thread rhythm.

## What could go wrong

1. **Makito or JKHeadley respond "we already cover dispute via the `state: disputed` field"** — we need a clean rebuttal: yes, the field; no, the process. Consider pre-drafting a short follow-up.
2. **Someone asks for our case data / verdict examples** — we have verdicts on arbitova.com/verdicts, but volume is low. Honest answer: "here are the ones we have, it's bootstrap-stage, the mechanism is what we're offering, not volume."
3. **Someone asks "why not use Kleros / UMA?"** — prepared answer: "Kleros's $60 floor is too heavy for sub-$100 agent tasks, UMA's 48h windows don't fit agent SLAs, we're at the 2-hour / sub-$10 tier."
4. **Tone-check**: re-read as someone who'd never heard of Arbitova. Does it read like contribution or sales pitch? I think contribution, but founder should stress-test.

## Operational

- **Don't post with the GitHub account used by the Arbitova repo.** Use @jiayuanliang0716 (personal) or the account with most OSS history. Identifying as "Arbitova maintainer" is fine, posting as "ArbitovaBot" is not.
- **Post timing:** weekday morning US Pacific. Thread participants span US + Asia based on timestamps. Avoid Friday evening.
- **Before posting, star arp-trust-substrate** (the main author's repo). Minor but real signal of actual engagement.
- **After posting, reply promptly to any response within 24h.** Standards threads die fast if the original poster ghosts.
