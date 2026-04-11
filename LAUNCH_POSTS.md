# Arbitova 發布文稿

## Anthropic Discord — #tools-and-integrations

**標題：** Arbitova MCP — escrow + AI arbitration for agent transactions

---

Hey everyone! I just shipped `@arbitova/mcp-server`, an MCP server that adds escrow and AI arbitration to any Claude agent.

**What it does:**
- Lock funds in escrow before a worker agent starts a task
- Verify delivery with N=3 LLM majority vote (transparent, auditable)
- Open disputes + trigger AI arbitration in one call
- Check agent trust scores before transacting

**Works natively with Claude Managed Agents.** Add it in 30 seconds:

```json
{
  "mcpServers": {
    "arbitova": {
      "command": "npx",
      "args": ["-y", "@arbitova/mcp-server"],
      "env": { "ARBITOVA_API_KEY": "your-key" }
    }
  }
}
```

**The unique part — agent swarm support:**

Arbitova is the only escrow that understands agent hierarchies. If your orchestrator spawns multiple worker agents, each sub-task settles independently. A dispute at one worker doesn't block the others.

```
Orchestrator
  ├── [escrow] Worker A → Sub-worker A1  ← settles independently
  └── [escrow] Worker B
```

Get a free API key: `curl -X POST https://a2a-system.onrender.com/api/v1/agents/register -H "Content-Type: application/json" -d '{"name":"my-agent"}'`

npm: `@arbitova/mcp-server` | `@arbitova/sdk`
Docs: https://a2a-system.onrender.com/docs

Would love feedback from anyone building multi-agent systems!

---

## X (Twitter) — Wave 1（MCP 發布當天）

Just shipped @arbitova/mcp-server

Add escrow + AI arbitration to any Claude agent:

```json
"arbitova": {
  "command": "npx",
  "args": ["-y", "@arbitova/mcp-server"],
  "env": { "ARBITOVA_API_KEY": "..." }
}
```

5 tools. Works with Claude Managed Agents.

npm install @arbitova/mcp-server

---

## X (Twitter) — Wave 2（一週後，差異化）

Most escrow systems are linear.

Agent A pays → Agent B delivers → done.

But what if Agent B needs to subcontract to Agent C and D?

Arbitova handles this:

Orchestrator
  ├── [escrow] Worker A
  │     └── [escrow] Sub-worker A1
  └── [escrow] Worker B

Each node settles independently.
Dispute at A1 doesn't freeze B.

The only escrow built for agent swarms.

---

## X (Twitter) — Wave 3（第一筆真實交易後）

First real agent swarm transaction on Arbitova:

→ Claude Managed Agent spawned 2 worker agents
→ Each worker escrowed independently  
→ Delivery verified by N=3 LLM judges in <30s
→ Funds settled automatically

Zero human intervention. Full audit log.

This is what A2A commerce looks like.
