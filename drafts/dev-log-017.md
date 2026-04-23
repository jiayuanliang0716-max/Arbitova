---
slug: dev-log-017-what-the-audit-actually-broke
title: "Dev Log #017 — What the Audit Actually Broke"
category: changelog
excerpt: "The self-audit in #016 said 'three SDKs plus arbiter plus non-custodial, all shipped.' When I went back and re-read my own claims line by line, two of them were still lying. Here's what I found in my own prod and the two fixes I shipped before touching another GTM channel."
cover_image: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=1200&h=675&fit=crop&q=80"
---

## TL;DR

After the self-audit in #016, I re-read my own "shipped" claims against the actual running infrastructure. Two of them were still wrong:

1. **Smithery's HTTP `/mcp` endpoint was serving the old Path A marketplace tools** (60 tools, `service_id`, `order_id`, the whole pre-pivot API). Anyone who installed the official MCP via Smithery was getting a product we retired.
2. **`MOLTBOOK_API_KEY` was hardcoded in `render.yaml`**, and the key value was already in git history (commit `afe4832`). "We removed it from the source file" ≠ "it's no longer leaked."

Both are fixed. Neither fix is interesting on its own, but the pattern is: when you ship fast, your own status page will lie to you. You need a second pass that re-reads every claim against the live system.

## #1 — The Smithery `/mcp` endpoint was still Path A

Path B's whole premise is **non-custodial**: your agent's signing key stays local, Arbitova never sees it. So the question for an HTTP-based MCP endpoint is: what does it even mean to "call a tool" when you can't hold the signing key?

The answer is that it **shouldn't** — the HTTP endpoint should be read-only by design, and signing tools should live in the stdio MCP package (`npx -y @arbitova/mcp-server`) where the key never leaves the user's machine.

The old endpoint quietly proxied every call through `api.arbitova.com` with an `X-API-Key` header, routing into the Path A Express monolith's order/service/arbitration handlers. That meant:

- `arbitova_create_escrow` expected a `service_id`. There are no services anymore.
- `arbitova_verify_delivery` called `/orders/:id/auto-arbitrate`. There are no orders anymore.
- The endpoint worked *enough* to return JSON, but every call was against a vestigial marketplace model.

What the endpoint looks like now:

- `tools/list` returns the 7 real Path B tools (`create_escrow`, `mark_delivered`, `confirm_delivery`, `dispute`, `cancel_if_not_delivered`, `escalate_if_expired`, `get_escrow`), each with a description that **names the on-chain semantics**, not the old off-chain ones.
- `arbitova_get_escrow` runs against the Base RPC directly — no auth, no API key, no Arbitova API call. Just `escrowRead.getEscrow(id)`.
- The six write tools deliberately return a structured error:

```json
{
  "ok": false,
  "error": "signing_required",
  "hint": "This tool requires a local signing key. HTTP MCP is read-only by design (non-custodial). Install the stdio MCP server locally: `npx -y @arbitova/mcp-server` and set ARBITOVA_AGENT_PRIVATE_KEY.",
  "install": "npx -y @arbitova/mcp-server"
}
```

That's a deliberate choice, not a limitation: **an HTTP endpoint that accepts a private key is a custody service.** We don't do that.

## #2 — A key in `render.yaml` is a key in git

`render.yaml` had:

```yaml
envVars:
  - key: MOLTBOOK_API_KEY
    value: moltbook_sk_...
```

The file is `.gitignore`'d on this branch — *now*. But `git log -p --all -S moltbook_sk_` finds the same string in commit `afe4832` (where `src/moltbook-agent.js` originally inlined the key before a later "security: remove hardcoded..." commit stripped it from the JS file but not from the yaml).

Changed to:

```yaml
envVars:
  - key: MOLTBOOK_API_KEY
    sync: false
```

Which tells Render to pull the value from the dashboard instead of from source. The value itself still needs to be rotated on the MoltBook side — removing a leaked secret from `HEAD` doesn't un-leak it from the reflog.

## Why write this up instead of just fixing it

Two reasons.

**One**: if you ship in public — and every Arbitova dev log is an attempt to do that — you have to show when your own status claims turn out to be wrong. The #016 post said "Path B is shipped." That was mostly true. This post is the part that wasn't.

**Two**: the pattern I keep seeing in my own work is that the *discovery* surface and the *execution* surface drift apart faster than the audit can catch. The SDK README is fine. The contract is fine. The three framework demos pass end-to-end. But the single most visible distribution channel — the Smithery listing — was still pointing at last month's product. That's exactly where external first-time users land.

If you're shipping an AI agent protocol, your primary responsibility is that the thing someone pastes into Claude Desktop config matches the thing you say you built. Today it does.

## What's next

- Path B arbiter/indexer deploy to Render (blocked on paid worker plan decision + `ANTHROPIC_API_KEY` validity check)
- Base Sepolia EscrowV1 source verify on Basescan
- The Path A Express monolith on `api.arbitova.com` — full takedown vs. leave-running decision
