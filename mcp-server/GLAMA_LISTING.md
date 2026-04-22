# Glama MCP Server Listing — Prep Doc

**Status:** BLOCKED on Path B rewrite (see task B4.1).
**Purpose:** Once `@arbitova/mcp-server` is rewritten for Path B, this doc captures the submission content for https://glama.ai/mcp/servers and unblocks awesome-mcp-servers PR #5152 (`missing-glama` label).

---

## Why this is blocked

`@arbitova/mcp-server@3.4.0` is currently a **Path A API client**:
- Requires `ARBITOVA_API_KEY` env var
- Hits `https://a2a-system.onrender.com/api/v1/*` REST endpoints
- 55 tools wrapping the custodial order/escrow/reputation API

Glama's listing process runs the server in a container, sends an MCP `listTools` introspection request, and scores based on what it sees. With the Path A server, Glama would either:
- Fail to start (no API key provided in the sandbox)
- List 55 tools that describe custodial flows, contradicting our RFC + README
- Score poorly because the tool descriptions don't match what the README promises

**Listing now would actively hurt us.** Do it after B4.1.

---

## What we'll submit once unblocked

### Server identity
- **Name:** `@arbitova/mcp-server`
- **Glama path:** `jiayuanliang0716-max/Arbitova`
- **Category:** Finance & Fintech
- **One-liner:** Non-custodial on-chain escrow + AI arbitration for agent-to-agent USDC payments on Base.

### Install command for the Glama sandbox
```bash
npx -y @arbitova/mcp-server@4.0.0
```

### Environment variables it needs (post-B4.1)
| Name | Required | Purpose |
|---|---|---|
| `ARBITOVA_RPC_URL` | yes | Base mainnet or Sepolia RPC endpoint (recommend Alchemy or public node). For introspection-only: use public Sepolia RPC. |
| `ARBITOVA_WALLET_KEY` | no (for introspection) | Private key for signing contract calls. If unset, server runs read-only — lists tools but fails any tx. |
| `ARBITOVA_CONTRACT_ADDRESS` | no | Defaults to canonical Sepolia: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` |

For Glama's introspection check: `ARBITOVA_RPC_URL=https://sepolia.base.org` is sufficient. No wallet key needed to pass listTools.

### Post-B4.1 tool surface (6 core tools + helpers)
```
arbitova_create_escrow
arbitova_mark_delivered
arbitova_confirm_delivery
arbitova_dispute
arbitova_resolve       (arbiter only)
arbitova_get_escrow
arbitova_verify_delivery_hash   (helper — no tx)
arbitova_get_fee_quote          (helper — no tx)
```

### Dockerfile to include in the repo (for Glama build checks)

```dockerfile
# Place at mcp-server/Dockerfile
FROM node:20-alpine

WORKDIR /app

# Only copy what we need for the server
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY prompts/ ./prompts/

# Non-root user
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp

# MCP servers speak over stdio by default
ENTRYPOINT ["node", "index.js"]
```

**Don't build this until B4.1 ships.** The current `index.js` will fail without `ARBITOVA_API_KEY`, which Glama won't have.

### Glama badge (post-approval)

Once Glama approves, they'll issue a score badge URL like:
```
[![OWNER/REPO MCP server](https://glama.ai/mcp/servers/OWNER/REPO/badges/score.svg)](https://glama.ai/mcp/servers/OWNER/REPO)
```

Add that to:
1. `awesome-mcp-servers` PR #5152 (moves `missing-glama` label off → allows merge)
2. The main Arbitova README
3. `@arbitova/mcp-server` npm README

### Submission steps (post-B4.1 checklist)
1. [ ] B4.1 ships — mcp-server 4.0.0 published on npm, Path B contract-based
2. [ ] `npx @arbitova/mcp-server@4.0.0` starts cleanly in Docker with just `ARBITOVA_RPC_URL` set
3. [ ] `listTools` introspection returns expected 6 core tools
4. [ ] Submit at https://glama.ai/mcp/servers with the Dockerfile
5. [ ] Wait for Glama score (usually 24-48h based on what I see in awesome-mcp-servers)
6. [ ] Update `awesome-mcp-servers` PR #5152 README line to add the score badge → force-push
7. [ ] Ping `punkpeye` on the PR comment thread: badge added, please re-run labels

---

## What this doc is for

If I (or anyone) resume this in a future session, the key facts to carry:

- Glama listing depends on `@arbitova/mcp-server` actually being a working Path B server. Don't submit with the current 3.4.0.
- B4.1 unblocks this. Nothing else.
- The awesome-mcp-servers PR #5152 is a single label (`missing-glama`) away from mergeable. That label drops the moment we have the score badge.
- Estimated total time from B4.1 completion to PR #5152 merged: 3-5 days, mostly Glama queue time.
