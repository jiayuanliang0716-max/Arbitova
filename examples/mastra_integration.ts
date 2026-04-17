/**
 * Arbitova + Mastra Integration Example
 *
 * Wraps Arbitova escrow and arbitration as Mastra tools, so a Mastra
 * agent can lock funds, deliver work, confirm, dispute, and arbitrate
 * on behalf of its operator.
 *
 * Install:
 *   npm install @mastra/core @ai-sdk/anthropic @arbitova/sdk zod
 *
 * Env:
 *   ARBITOVA_API_KEY   — from https://arbitova.com
 *   ANTHROPIC_API_KEY  — model provider
 *
 * Run:
 *   npx tsx examples/mastra_integration.ts
 */

import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { anthropic } from '@ai-sdk/anthropic';
import { Arbitova } from '@arbitova/sdk';
import { z } from 'zod';

const arbitova = new Arbitova({ apiKey: process.env.ARBITOVA_API_KEY! });

// ── Arbitova Tools ───────────────────────────────────────────────────────────

const checkReputation = createTool({
  id: 'arbitova_check_reputation',
  description:
    'Look up an agent reputation score before transacting. Returns score, level, and per-category breakdown.',
  inputSchema: z.object({
    agent_id: z.string().describe('The Arbitova agent ID to check'),
  }),
  execute: async ({ context }) => arbitova.getReputation(context.agent_id),
});

const lockEscrow = createTool({
  id: 'arbitova_escrow',
  description:
    'Place an order and lock buyer funds in Arbitova escrow. Funds stay locked until the buyer confirms delivery or a dispute is resolved.',
  inputSchema: z.object({
    service_id: z.string(),
    requirements: z.record(z.any()).describe('Task spec passed to the seller'),
  }),
  execute: async ({ context }) =>
    arbitova.escrow({
      serviceId: context.service_id,
      requirements: context.requirements,
    }),
});

const confirmDelivery = createTool({
  id: 'arbitova_confirm',
  description:
    'Confirm delivery and release escrow to the seller (minus 0.5% platform fee). Only call when the delivered work matches requirements.',
  inputSchema: z.object({ order_id: z.string() }),
  execute: async ({ context }) => arbitova.confirm(context.order_id),
});

const openDispute = createTool({
  id: 'arbitova_dispute',
  description:
    'Open a dispute on a delivered order. Funds stay locked. Use this when delivery does not meet requirements.',
  inputSchema: z.object({
    order_id: z.string(),
    reason: z.string(),
    evidence: z.record(z.any()).optional(),
  }),
  execute: async ({ context }) =>
    arbitova.dispute(context.order_id, {
      reason: context.reason,
      evidence: context.evidence,
    }),
});

const runArbitration = createTool({
  id: 'arbitova_arbitrate',
  description:
    'Trigger N=3 AI arbitration on a disputed order. Returns verdict with winner, confidence, and reasoning.',
  inputSchema: z.object({ order_id: z.string() }),
  execute: async ({ context }) => arbitova.arbitrate(context.order_id),
});

const proposeCounterOffer = createTool({
  id: 'arbitova_counter_offer',
  description:
    'Seller proposes a partial refund to settle a dispute without arbitration. Buyer accepts (closes dispute) or declines. Rate-limited to one proposal per hour.',
  inputSchema: z.object({
    order_id: z.string(),
    refund_amount: z.number().describe('USDC to return to buyer'),
    seller_keeps: z.number().describe('USDC the seller keeps (before 2% dispute fee)'),
  }),
  execute: async ({ context }) =>
    arbitova.counterOffer(context.order_id, {
      refundAmount: context.refund_amount,
      sellerKeeps: context.seller_keeps,
    }),
});

// ── Agent ────────────────────────────────────────────────────────────────────

const orchestrator = new Agent({
  name: 'Arbitova Orchestrator',
  instructions: `You are a trust-aware orchestrator for agent-to-agent commerce.

Workflow:
1. Before hiring any seller, check their reputation. Skip if score < 30.
2. Lock funds in escrow with clear requirements.
3. After the seller delivers, inspect the output. If it matches, confirm.
4. If it does not match, open a dispute with specific evidence. Then run arbitration.
5. If the seller offers a counter-offer that keeps the buyer whole enough, consider accepting to avoid arbitration fees.

Never release funds without verifying delivery. Never skip the reputation check.`,
  model: anthropic('claude-sonnet-4-6'),
  tools: {
    checkReputation,
    lockEscrow,
    confirmDelivery,
    openDispute,
    runArbitration,
    proposeCounterOffer,
  },
});

export const mastra = new Mastra({ agents: { orchestrator } });

// ── Example Run ──────────────────────────────────────────────────────────────

async function main() {
  const result = await orchestrator.generate(
    "I need agent 'agnt_abc123' to run service 'srv_code_review' on my TypeScript repo. " +
      'Check their reputation first, then lock funds in escrow with requirement: review auth.ts for type errors.'
  );
  console.log(result.text);
}

if (require.main === module) {
  main().catch(console.error);
}
