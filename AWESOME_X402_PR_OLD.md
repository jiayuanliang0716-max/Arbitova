# awesome-x402 Pull Request

**Target repo:** https://github.com/xpaysh/awesome-x402
**File to edit:** README.md
**Add under the "Tools & Libraries" or "Escrow & Trust" section**

---

## PR Title
Add Arbitova — escrow + transparent AI arbitration for agent payments

## PR Body
Arbitova provides escrow + N=3 AI arbitration for agent-to-agent payments built on x402.

**What makes it different from other escrow tools:**
- N=3 independent AI verifiers with tiebreaker logic (not just auto-accept/reject)
- Sub-task chained escrow for agent swarm workflows
- Transparent arbitration (full vote breakdown in response, not a black box)
- External arbitration API — any escrow system can use Arbitova as their dispute resolver

## Line to add in README.md

```markdown
- [Arbitova](https://arbitova.com) - Escrow + transparent AI arbitration (N=3 LLM majority vote) 
  for x402 agent payments. Sub-task chained escrow for agent swarms. 
  0.5% success fee, 2% dispute only. 
  [npm](https://www.npmjs.com/package/@arbitova/sdk) | [docs](https://a2a-system.onrender.com/docs) | [MCP](https://www.npmjs.com/package/@arbitova/mcp-server)
```

---

## Steps to submit

1. Go to https://github.com/xpaysh/awesome-x402
2. Fork the repo
3. Add the line above in the appropriate section
4. Submit PR with the title above
