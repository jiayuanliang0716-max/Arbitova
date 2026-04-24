# @arbitova/mcp-server

[![jiayuanliang0716-max/Arbitova MCP server](https://glama.ai/mcp/servers/jiayuanliang0716-max/Arbitova/badges/score.svg)](https://glama.ai/mcp/servers/jiayuanliang0716-max/Arbitova)

Official MCP server for [Arbitova](https://arbitova.com) — on-chain USDC escrow and AI arbitration for agent-to-agent payments on Base.

Non-custodial: your agent signs every transaction locally. Arbitova never holds funds.

## What it does

Exposes the seven `EscrowV1` contract entrypoints as MCP tools so any MCP-compatible agent (Claude Desktop, Claude Code, custom clients) can lock USDC into escrow, mark delivery, confirm, dispute, cancel, or escalate on timeout — all on Base, all signed with the agent's own key.

If a buyer agent goes silent within the review window, funds auto-escalate to AI arbitration. Silence is not consent.

## Install

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "arbitova": {
      "command": "npx",
      "args": ["-y", "@arbitova/mcp-server"],
      "env": {
        "ARBITOVA_RPC_URL": "https://sepolia.base.org",
        "ARBITOVA_ESCROW_ADDRESS": "0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC",
        "ARBITOVA_USDC_ADDRESS": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "ARBITOVA_AGENT_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

## Environment variables

| Name | Required | Purpose |
|---|---|---|
| `ARBITOVA_RPC_URL` | yes | Base JSON-RPC endpoint (Sepolia: `https://sepolia.base.org`, Mainnet: `https://mainnet.base.org`) |
| `ARBITOVA_ESCROW_ADDRESS` | yes | Deployed EscrowV1 address. Sepolia: `0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC` |
| `ARBITOVA_USDC_ADDRESS` | yes | USDC on your chosen network. Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — Mainnet: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `ARBITOVA_AGENT_PRIVATE_KEY` | no | Agent wallet key (0x-prefixed). Signs locally, never transmitted. Omit for read-only mode (only `arbitova_get_escrow` will work). |

## Tools

| Tool | Role | Effect |
|---|---|---|
| `arbitova_create_escrow` | buyer | `approve` + `createEscrow` — locks USDC |
| `arbitova_mark_delivered` | seller | `markDelivered` with `keccak256(deliveryPayloadURI)` |
| `arbitova_confirm_delivery` | buyer | `confirmDelivery` — releases funds to seller |
| `arbitova_dispute` | either | `dispute(reason)` — triggers AI arbitration |
| `arbitova_cancel_if_not_delivered` | buyer | refund after delivery deadline if seller silent |
| `arbitova_get_escrow` | anyone | reads on-chain escrow state |

All tools return `{ ok: true, ... }` on success or `{ ok: false, error, hint }` on failure.

## Resources

Three markdown protocols (buyer verification, seller delivery, arbiter self-check) and the EscrowV1 ABI, served over `resources/read`:

```
arbitova://prompts/buyer-verification
arbitova://prompts/seller-delivery
arbitova://prompts/arbitrator-self-check
arbitova://resources/escrow-abi
```

## Read-only mode

Omit `ARBITOVA_AGENT_PRIVATE_KEY`. The server boots, `tools/list` returns all seven tool schemas, and `arbitova_get_escrow` works. Any write tool returns a clear hint: set the key to enable signing. Useful for observability, registry introspection, and dry-run exploration.

## Migrating from v3.x

v4.0.0 is a full rewrite: v3.x was a Path A custodial HTTP client (`ARBITOVA_API_KEY` → `a2a-system.onrender.com`). v4.0.0 signs on-chain directly. See [MIGRATION.md](./MIGRATION.md) for the full diff and a config example.

If you still need the old behavior, `npm install @arbitova/mcp-server@3.4.0` remains available but is deprecated.

## Links

- Repository: <https://github.com/jiayuanliang0716-max/Arbitova>
- Contract: [EscrowV1.sol](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/contracts/src/EscrowV1.sol)
- 15-minute paid-agent tutorial: [docs/tutorials/15-min-paid-agent.md](https://github.com/jiayuanliang0716-max/Arbitova/blob/master/docs/tutorials/15-min-paid-agent.md)
- Issues / feedback: <https://github.com/jiayuanliang0716-max/Arbitova/issues>

## License

MIT
