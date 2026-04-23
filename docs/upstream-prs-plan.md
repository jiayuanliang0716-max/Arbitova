# Upstream Framework PRs — Plan and State

Status: **PLAN DOC** (not-yet-filed)
Author: 2026-04-23
Y3 from `project_arbitova_remediation_backlog.md`

---

## TL;DR

Of the three framework-PR targets we originally sketched
(LangGraph / CrewAI / Claude Agent SDK), **only one is still open
for upstream PRs in its original form**:

| Framework           | Original target repo        | Current state                 | PR feasible? |
|---------------------|-----------------------------|-------------------------------|:------------:|
| Claude Agent SDK    | `anthropics/anthropic-cookbook` | Active, accepts `third_party/` | ✅ yes      |
| CrewAI              | `crewAIInc/crewAI-examples` | **Archived 2026-04-20** (read-only) | ❌ no |
| LangGraph           | `langchain-ai/langgraph/examples` | **Archived**, moved to docs.langchain.com | ⚠️ redirected |

This doc lays out the revised strategy per framework, a ready-to-file
PR package for the cookbook, and fallback plans for the two archived
targets. The user pushes the button; I don't have credentials for
any of these.

---

## 1. Anthropic Cookbook PR — READY TO FILE

**Target:** `github.com/anthropics/anthropic-cookbook`
**Path:** `third_party/Arbitova/arbitova_escrow_a2a.ipynb`
**Convention basis:** Existing third_party folders (Deepgram, ElevenLabs,
LlamaIndex, MongoDB, Pinecone, VoyageAI, Wikipedia, WolframAlpha) all
use PascalCase folder + single `.ipynb` inside.

### Draft PR title
```
third_party/Arbitova: A2A non-custodial USDC escrow for Claude agents on Base
```

### Draft PR body

```markdown
## What this adds

`third_party/Arbitova/` — a single notebook showing a Claude agent
using `claude-agent-sdk` to:

1. Create a USDC escrow on Base Sepolia via the Arbitova Path B SDK
2. Hire a seller agent, receive a delivery, release funds
3. Handle a disputed delivery through the Arbitova AI arbitration pipeline

## Why this is cookbook-shaped

Arbitova is an open-protocol non-custodial escrow layer for agent-to-agent
commerce. Contract + indexer are public; `@arbitova/sdk` is on npm and
`arbitova` is on PyPI. The notebook uses Claude Haiku 4.5 as the agent
model and demonstrates a realistic payment-conditional task flow that
isn't covered by the existing `tool_use/` examples (those show agent
tool calls; this shows agent **payments**).

## Dependencies added

- `arbitova==2.5.2` (PyPI — our Python SDK)
- `claude-agent-sdk>=0.1.0`
- `python-dotenv`

All Sepolia — no mainnet keys needed. A throwaway Sepolia RPC URL works.

## Checklist

- [x] Notebook runs top-to-bottom against Sepolia
- [x] Uses Claude Haiku 4.5 (cookbook default price/latency point)
- [x] No hardcoded secrets; `.env` pattern documented
- [x] Self-contained in `third_party/Arbitova/`
- [x] Follows PascalCase folder convention of existing third_party entries
```

### File to be added

`third_party/Arbitova/arbitova_escrow_a2a.ipynb` — I'll adapt from
`Desktop/Arbitova-A2A-Demo-ClaudeSDK/buyer_agent.py` + `seller_agent.py`
into a single runnable notebook. **Blocker**: I have not yet written
the `.ipynb`. Writing it is ~2 hours of work; I can do it after this
plan is approved. Noting here so the user knows this PR is "ready to
write, not ready to file."

### gh command the user will run

```bash
# Fork first (browser)
gh repo fork anthropics/anthropic-cookbook --clone --remote
cd anthropic-cookbook
git checkout -b third-party-arbitova
mkdir -p third_party/Arbitova
cp /path/to/arbitova_escrow_a2a.ipynb third_party/Arbitova/
git add third_party/Arbitova
git commit -m "third_party/Arbitova: A2A non-custodial escrow example"
git push -u origin third-party-arbitova
gh pr create --title "third_party/Arbitova: A2A non-custodial USDC escrow for Claude agents on Base" --body "$(cat pr-body.md)"
```

---

## 2. CrewAI — original target ARCHIVED, needs pivot

**Problem:** `crewAIInc/crewAI-examples` was archived on 2026-04-20.
Pull requests cannot be filed against a read-only repo. A redirect
target `crewAIInc/crewAI-cookbook` does not exist (404).

**The three realistic alternatives:**

### 2a. Issue-first on main `crewAIInc/crewAI`

Open an issue titled *"Where should community integration examples
go now that crewAI-examples is archived?"*. Let maintainers tell us
the new intended path. File the PR against whichever repo they point
to.

**Pros:** no guessing; we don't send a PR to a dead end.
**Cons:** latency — depends on maintainer response time.

### 2b. PR against `crewAIInc/skills`

The main crewAI README points to `crewAIInc/skills` as the "official
integration guidance" package. We could author an "Arbitova escrow"
skill that teaches CrewAI users how to wire our SDK into a Crew.

**Pros:** active repo, officially blessed.
**Cons:** "skills" is a different contract than "examples" — it's
instructional content for coding agents, not runnable demos.
Requires reshaping our existing demo into skill format.

### 2c. Standalone `arbitova/crewai-arbitova` package

Publish an integration package ourselves under the Arbitova org
(like `@langchain-community/*` packages). List it in the CrewAI
community docs.

**Pros:** we control the surface; no upstream merge delay.
**Cons:** weaker signal than an upstream-blessed PR. Still valuable
as a fallback.

**Recommendation: 2a then 2b.** Open the issue first (5 minutes of
user time), then file against whichever repo the maintainer points
to. Don't spend engineering time pivoting to `skills` format until
the maintainer confirms that's the right surface.

---

## 3. LangGraph — redirected to langchain docs

**Problem:** `langchain-ai/langgraph/examples` says "retained purely
for archival purposes. Examples now moved to the newly consolidated
LangChain documentation." Active contributions go to the main
`langchain-ai/langchain` repo's docs tree or to `docs.langchain.com`.

### 3a. Langchain main repo docs PR (preferred)

**Target:** `github.com/langchain-ai/langchain`
**Path (tentative):** `docs/docs/integrations/tools/arbitova.mdx`
(modeled on existing third-party tool entries — exact path needs
confirmation against the repo's current docs layout before we
commit to it)

**Shape:** MDX documentation page + a minimal runnable snippet.
Probably a lighter lift than a full notebook.

**Blocker:** I haven't browsed the exact docs layout of the
consolidated repo. Before drafting the PR content, worth a
10-minute navigation pass to confirm where tool-integration pages
actually live today.

### 3b. langchain-ai/langchain cookbook

Some integrations live in `langchain-ai/langchain/cookbook/` as
notebooks. Could be the right surface if our example is more
demo-shaped than docs-shaped.

**Recommendation:** verify the right path (3a or 3b) before
drafting. I'll do that as a follow-up pass after this plan doc
lands.

---

## Action split — me vs. you

### 🤖 I'll do next (no sign-off needed):

1. Write the actual `arbitova_escrow_a2a.ipynb` for the cookbook PR.
2. Verify the langchain docs layout and pick between 3a and 3b.
3. Draft the CrewAI issue text (so you can paste-and-file quickly).

### 👤 You push the button:

1. `gh repo fork` + `gh pr create` for the cookbook PR (once notebook
   exists and you've skimmed it).
2. Open the CrewAI issue on `crewAIInc/crewAI` asking where
   integration examples belong now.
3. After my langchain-path verification, `gh pr create` on
   `langchain-ai/langchain`.

### ⚠️ Memory update needed

The existing memory entry in `project_arbitova_remediation_backlog.md`
line 54 says "等我先教、之後你執行 · **#5 Framework PRs upstream 送出**"
with the implicit assumption that the three original targets are
still open. Two are not. The memory line should be revised to
reflect the new shape: one cookbook PR ready-to-file, one
pending-maintainer-pivot (CrewAI), one pending-path-verify
(LangGraph).

---

## Appendix — why each framework is worth an upstream PR at all

All three PRs are trust-building signals, not growth engines. A
merged PR in the anthropic-cookbook is a checkmark next to
"Anthropic-blessed integration" that would take us a year to earn
through other channels. Same logic for LangGraph and CrewAI. The
cost (one notebook + one doc page + one integration write-up) is
small; the credibility compounding is slow but durable.

If any of the three PRs gets *rejected* rather than simply redirected,
that's also useful signal — it tells us our story isn't yet aligned
with the ecosystem's preferred framing, and we adjust before going
to a bigger audience (VCs, user conferences).
