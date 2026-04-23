---
target: LangChain co-marketing (Twitter @LangChain, LinkedIn, or direct inbound)
basis: docs.langchain.com "co-marketing" contribution guide 2026-04-24 — multi-agent architectures are an explicit "we get excited about" category
tone: short, developer-peer, no hype
---

## Short DM / Twitter reply version (for @LangChain)

Built an end-to-end LangGraph example: a ReAct buyer agent hires a
seller agent on Base (Sepolia) via non-custodial USDC escrow, with
AI arbitration on disputes. Payment-conditional multi-agent workflow
— fits your "multi-agent architectures" bucket in the co-marketing
guide. Repo: github.com/jiayuanliang0716-max/Arbitova/tree/master/examples/langgraph

## Longer DM / email version (for partnerships inbound)

Hi LangChain team — saw the co-marketing guide mentions
multi-agent architectures as something you'd like to highlight.

Arbitova is an open protocol for agent-to-agent payments on Base:
two agents lock USDC into a contract, one delivers, the other
confirms, and a neutral arbiter resolves if they disagree. No
custody, no keys held by us — the contract is the whole thing.

I built a LangGraph reference that shows this end-to-end: a ReAct
buyer agent negotiates with a seller agent, locks funds via
`@arbitova/sdk` through a LangChain `Tool`, the seller delivers a
content-hash-pinned payload, and the buyer confirms or disputes.
The arbiter (also LangGraph-shaped) is an AI ensemble that
publishes every verdict publicly at arbitova.com/verdicts.

It's a concrete answer to "how should agents pay each other when
they don't share a bank account," which every A2A spec in the wild
(MCP, Google A2A, Coinbase Agent Commerce) leaves open. LangGraph
is the orchestration layer in the reference — the state machine
shape is a natural fit.

**Repo:** github.com/jiayuanliang0716-max/Arbitova
**LangGraph example:** [examples/langgraph/](https://github.com/jiayuanliang0716-max/Arbitova/tree/master/examples/langgraph)
**Contract:** `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` on Base Sepolia
**Spec:** [A2A-ESCROW-RFC-v0.1](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/spec/A2A-ESCROW-RFC-v0.1.md)

Happy to write a guest blog, record a walk-through video, or
tighten the example to whatever shape you'd find most useful. No
asks beyond the demo itself — just thought it'd be developer-useful
content if it fits what you're currently curating.

— Jiayuan

## Why this framing

- Opens with **their** stated criteria ("multi-agent architectures"), not a feature dump
- Explains the gap in the A2A/agent-commerce space in one sentence
- Gives them a runnable repo and a contract address they can verify independently
- Offers flexible formats (blog / video / doc page) instead of over-specifying
- No asks beyond the demo — reduces friction on their side

## What NOT to include

- Dev Log numbers (internal context, noise for outsiders)
- Path A / Path B framing (internal pivot history, noise)
- Kleros references (already scrubbed site-side; don't resurrect in outbound)
- Any language suggesting we want mainnet launch press (we're not ready)
