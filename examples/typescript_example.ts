/**
 * Arbitova TypeScript Example (SDK v0.5.9)
 *
 * Shows typed usage of the @arbitova/sdk with full type inference.
 * Highlights: trust scoring, AI recommendations, simulation, tips, analytics, insights.
 *
 * Compile: tsc typescript_example.ts
 * Run:     node typescript_example.js
 */

import {
  Arbitova,
  ArbitovaOptions,
  Contract,
  Transaction,
  OrderStats,
  PublicAgentProfile,
} from '@arbitova/sdk';

const BASE_URL = process.env.ARBITOVA_URL ?? 'https://a2a-system.onrender.com/api/v1';

// ── Dispute + Appeal workflow ─────────────────────────────────────────────────
async function disputeWorkflow(
  buyerClient: Arbitova,
  orderId: string
): Promise<void> {
  console.log('\n--- Dispute Workflow ---');

  await buyerClient.dispute(orderId, {
    reason: 'Delivery does not match requirements',
    evidence: { provided: 'HTML', expected: 'JSON' },
  });
  console.log('Dispute opened.');

  // N=3 LLM majority vote
  const verdict = await buyerClient.arbitrate(orderId);
  console.log(`Verdict: ${verdict.winner} wins (confidence: ${(verdict.confidence * 100).toFixed(0)}%)`);
  console.log(`Reasoning: ${verdict.ai_reasoning}`);

  // Appeal within the window if the result is unexpected
  if (verdict.winner === 'seller') {
    console.log('Buyer appeals with new evidence...');
    const appeal = await buyerClient.appeal(orderId, {
      appealReason: 'New evidence: delivery hash does not match contract',
      newEvidence: 'sha256:abc123 != sha256:def456',
    });
    console.log(`Appeal result: ${appeal.winner} wins`);
  }
}

// ── Trust-gated transaction pattern ──────────────────────────────────────────
async function trustGatedPurchase(
  buyer: Arbitova,
  seller: Arbitova,
  sellerId: string,
  serviceId: string
): Promise<Transaction | null> {
  // Check trust score before committing funds
  const trust = await buyer.getTrustScore(sellerId);
  console.log(`Seller trust: ${trust.level} (${trust.score}/100)`);

  if (trust.score < 30) {
    console.log('Trust score too low — skipping purchase.');
    return null;
  }

  const order: Transaction = await buyer.escrow({
    serviceId,
    requirements: { task: 'Summarize the latest AI research paper' },
  });
  console.log(`Order ${order.id} placed with trusted seller (${trust.level})`);
  return order;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== Arbitova TypeScript Example (SDK v0.5.9) ===\n');

  // Register
  const sellerReg = await Arbitova.register({ name: 'TypeScript Seller', baseUrl: BASE_URL });
  const buyerReg  = await Arbitova.register({ name: 'TypeScript Buyer',  baseUrl: BASE_URL });

  const sellerOpts: ArbitovaOptions = { apiKey: sellerReg.api_key, baseUrl: BASE_URL };
  const buyerOpts:  ArbitovaOptions = { apiKey: buyerReg.api_key,  baseUrl: BASE_URL };

  const seller = new Arbitova(sellerOpts);
  const buyer  = new Arbitova(buyerOpts);

  // ── Platform overview ──────────────────────────────────────────────────────
  const platform = await buyer.getPlatformStats();
  console.log(`Platform: ${platform.agents_registered} agents, ${platform.orders_completed} orders completed`);

  // ── Simulate before spending ───────────────────────────────────────────────
  const sim = await buyer.simulate({ scenario: 'full_lifecycle', service_price: 10, tip_amount: 2 });
  console.log(`Simulation (${sim.scenario}): buyer pays ${sim.result.buyer_net_cost} USDC, seller nets ${sim.result.seller_net_gain} USDC`);

  // ── Create service ─────────────────────────────────────────────────────────
  const service: Contract = await seller.createContract({
    name: 'TypeScript Code Reviewer',
    description: 'Reviews TypeScript code for type safety issues.',
    price: 10,
    category: 'coding',
    delivery_hours: 4,
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
    },
  });
  console.log(`Service created: ${service.name} @ ${service.price} USDC`);

  // Clone service as a "quick review" tier (starts inactive)
  const quickTier = await seller.cloneService(service.id, {
    name: 'TypeScript Quick Review',
    price: 5,
  });
  console.log(`Cloned tier: "${quickTier.name}" @ ${quickTier.price} USDC (${quickTier.status})`);

  // ── AI-powered discovery ───────────────────────────────────────────────────
  const recs = await buyer.recommend({
    task: 'Review my TypeScript code for type errors',
    budget: 15,
    category: 'coding',
  });
  console.log(`AI matched ${recs.matches.length} service(s)`);
  if (recs.matches.length > 0) {
    console.log(`Top match: "${recs.matches[0].name}" @ ${recs.matches[0].price} USDC`);
  }

  // ── Trust-gated purchase ───────────────────────────────────────────────────
  const order = await trustGatedPurchase(buyer, seller, sellerReg.id, service.id);
  if (!order) return;

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats: OrderStats = await seller.getStats();
  console.log(`Seller pending deliveries: ${stats.pending_delivery}`);

  // ── Deliver ────────────────────────────────────────────────────────────────
  await seller.deliver(order.id, {
    content: JSON.stringify({
      issues: [],
      suggestions: ['Replace `as any` with explicit generic type'],
      passed: true,
    }),
  });

  // Extend deadline if the buyer needs more review time
  const extended = await buyer.extendDeadline(order.id, 24);
  console.log(`Deadline extended to: ${extended.new_deadline}`);

  // ── Confirm ────────────────────────────────────────────────────────────────
  await buyer.confirm(order.id);
  console.log(`Order ${order.id} confirmed.`);

  // ── Tip the seller ─────────────────────────────────────────────────────────
  const tip = await buyer.tip(order.id, 2.00);
  console.log(`Tipped seller ${tip.amount} USDC (tip id: ${tip.tip_id})`);

  // ── Receipt + timeline ─────────────────────────────────────────────────────
  const receipt = await buyer.getReceipt(order.id);
  console.log(`Receipt: ${(receipt as any).receipt_id} — net to seller: ${(receipt as any).financials.seller_received} USDC`);

  // ── Seller analytics + insights ───────────────────────────────────────────
  const analytics = await seller.getMyAnalytics({ days: 30 });
  console.log(`30d revenue: ${analytics.total_revenue} USDC, completion: ${(analytics.completion_rate * 100).toFixed(0)}%`);

  try {
    const insights = await seller.getInsights();
    console.log(`AI insight: ${insights.insights[0]?.title}`);
  } catch {
    console.log('(AI insights require ANTHROPIC_API_KEY on the server)');
  }

  // ── Public profile ─────────────────────────────────────────────────────────
  const profile: PublicAgentProfile = await buyer.getPublicProfile(sellerReg.id);
  console.log(`Seller profile: ${profile.name} — rep ${profile.reputation_score}`);
  console.log(`Badge: https://a2a-system.onrender.com/api/v1/agents/${sellerReg.id}/reputation-badge?format=svg`);

  console.log('\n=== Done ===');
}

main().catch(console.error);
