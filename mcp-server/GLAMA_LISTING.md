# Glama MCP Server Listing — Submission Prep

**Status:** UNBLOCKED as of 2026-04-22. `@arbitova/mcp-server@4.0.0` is Path B, on-chain, and passes a local stdio smoke test against Base Sepolia.

**Remaining step to submit:** `npm publish` v4.0.0 (user token required), then follow the submission checklist below.

---

## Server identity
- **Name:** `@arbitova/mcp-server`
- **MCP registry name:** `io.github.jiayuanliang0716-max/arbitova`
- **Repository:** `jiayuanliang0716-max/Arbitova`
- **Category:** Finance & Fintech
- **One-liner:** Non-custodial on-chain escrow + AI arbitration for agent-to-agent USDC payments on Base.

## Install command for the Glama sandbox
```bash
npx -y @arbitova/mcp-server@4.0.0
```

## Environment variables (v4.0.0)
| Name | Required | Purpose |
|---|---|---|
| `ARBITOVA_RPC_URL` | yes | Base RPC endpoint. For Glama's sandbox: `https://sepolia.base.org` |
| `ARBITOVA_ESCROW_ADDRESS` | yes | Deployed EscrowV1 address. Sepolia: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` |
| `ARBITOVA_USDC_ADDRESS` | yes | USDC token. Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| `ARBITOVA_AGENT_PRIVATE_KEY` | no | Omit for introspection / read-only mode. Signs locally, never leaves the process. |

For Glama's introspection check: the first three are sufficient. No wallet key needed to pass `tools/list` — the server boots in READ-ONLY mode, exposes all six tool schemas, and only blocks signing at call time.

## Tool surface (exactly 6)

```
arbitova_create_escrow
arbitova_mark_delivered
arbitova_confirm_delivery
arbitova_dispute
arbitova_get_escrow
arbitova_cancel_if_not_delivered
```

All six are thin wrappers over the deployed `EscrowV1` contract. No proprietary backend is involved — a user could reimplement the same surface against the ABI exported at `arbitova://resources/escrow-abi`.

## Resources exposed

```
arbitova://prompts/buyer-verification       (markdown — buyer safety protocol)
arbitova://prompts/seller-delivery          (markdown — seller delivery protocol)
arbitova://prompts/arbitrator-self-check    (markdown — arbiter verdict protocol)
arbitova://resources/escrow-abi             (json — EscrowV1 ABI)
```

## Dockerfile

Already at `mcp-server/Dockerfile`. Produces a ~40 MB `node:20-alpine` image, entrypoint `node /app/index.js`, stdio transport.

## Submission checklist

1. [ ] `npm publish` v4.0.0 from `mcp-server/` (user token)
2. [ ] Verify `npx -y @arbitova/mcp-server@4.0.0` starts cleanly with only `ARBITOVA_RPC_URL`, `ARBITOVA_ESCROW_ADDRESS`, `ARBITOVA_USDC_ADDRESS` set
3. [ ] Deprecate v3.4.0: `npm deprecate @arbitova/mcp-server@3.4.0 "Path A custodial client — use 4.x (non-custodial, on-chain) instead. See MIGRATION.md."`
4. [ ] Submit at <https://glama.ai/mcp/servers> with repo URL + Dockerfile
5. [ ] Wait for Glama score (24–48h based on queue patterns seen in awesome-mcp-servers)
6. [ ] Update `awesome-mcp-servers` PR #5152: add the score badge, force-push
7. [ ] Comment on PR #5152: badge added, please re-run labels

## Local smoke test (already run, 8/8 passed)

`node mcp-server/smoke-test.js` — boots the server, sends `initialize`, `tools/list`, `resources/list`, one `resources/read`, and two `tools/call` invocations. Verifies: v4.0.0 reported, 6 tools returned with correct names, descriptions >= 100 chars and free of Path A references, 4 resources listed, ABI contains `getEscrow` + `createEscrow`, write tools fail politely in read-only mode with a hint about `ARBITOVA_AGENT_PRIVATE_KEY`, and `get_escrow` actually decodes escrow 1 on Base Sepolia.

## Badge placement after approval

```
[![jiayuanliang0716-max/Arbitova MCP server](https://glama.ai/mcp/servers/OWNER/REPO/badges/score.svg)](https://glama.ai/mcp/servers/OWNER/REPO)
```

Add to:
1. `awesome-mcp-servers` PR #5152 README line (drops `missing-glama` label → mergeable)
2. Main Arbitova README
3. `@arbitova/mcp-server` npm README
