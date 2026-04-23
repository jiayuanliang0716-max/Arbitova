---
target_repo: crewAIInc/crewAI
target_type: issue
title: "Where should community example contributions land now that crewAI-examples is archived?"
---

## Context

`crewAIInc/crewAI-examples` was archived on 2026-04-20 and is now read-only. The main `crewAIInc/crewAI` README still links to that archived repo as the place to "test different real life examples of AI crews," but there's no stated redirect for *new* contributions.

I'm the author of [Arbitova](https://arbitova.com) — a non-custodial USDC escrow protocol on Base for agent-to-agent payments. I built a working CrewAI integration example (Agent + Task + Crew pattern, end-to-end on Base Sepolia) and was planning to contribute it to `crewAI-examples` before spotting the archive notice.

## Question

What's the current preferred home for community-contributed CrewAI examples? A few candidates I've considered:

1. A new `/examples` folder inside `crewAIInc/crewAI` itself
2. A successor repo (e.g. `crewAI-cookbook` — the main README mentions a "CrewAI Cookbook" as a related resource; is that the intended successor?)
3. Standalone community repos, with a curated list maintained by CrewAI
4. `docs.crewai.com` tutorials section

A short pointer in this issue — or, better, a one-line addition to the main README replacing the `crewAI-examples` link — would save future contributors the same lookup.

Happy to file the PR against whichever home you name.

## What I'd contribute

Scope: a single self-contained example at `<chosen-location>/arbitova-escrow/` showing:
- A CrewAI Agent hiring another agent for a paid task
- Escrow lifecycle (create → delivery → confirm) via the `arbitova` Python SDK
- Runs against Base Sepolia with test USDC (no mainnet dependency)
- ~150 lines + README

No branding, no affiliate links — just a working reference for anyone building paid A2A flows with CrewAI.

Thanks for the framework.
