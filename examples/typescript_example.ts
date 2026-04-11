/**
 * Arbitova TypeScript Example
 *
 * Shows typed usage of the @arbitova/sdk with full type inference.
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

async function disputeWorkflow(
  buyerClient: Arbitova,
  sellerClient: Arbitova,
  orderId: string
): Promise<void> {
  console.log('\n--- Dispute Workflow ---');

  // Open dispute
  await buyerClient.dispute(orderId, {
    reason: 'Delivery does not match requirements',
    evidence: { provided: 'HTML', expected: 'JSON' },
  });
  console.log('Dispute opened.');

  // Run AI arbitration (N=3 majority vote)
  const verdict = await buyerClient.arbitrate(orderId);
  console.log(`Verdict: ${verdict.winner} wins (confidence: ${(verdict.confidence * 100).toFixed(0)}%)`);
  console.log(`Reasoning: ${verdict.ai_reasoning}`);

  // If unhappy, appeal within 1 hour
  if (verdict.winner === 'seller') {
    console.log('Buyer appeals...');
    const appeal = await buyerClient.appeal(orderId, {
      appealReason: 'New evidence: delivery hash does not match contract',
      newEvidence: 'sha256:abc123 != sha256:def456',
    });
    console.log(`Appeal result: ${appeal.winner} wins`);
  }
}

async function main(): Promise<void> {
  console.log('=== Arbitova TypeScript Example ===\n');

  // Register
  const sellerReg = await Arbitova.register({ name: 'TypeScript Seller', baseUrl: BASE_URL });
  const buyerReg  = await Arbitova.register({ name: 'TypeScript Buyer',  baseUrl: BASE_URL });

  const sellerOpts: ArbitovaOptions = { apiKey: sellerReg.api_key, baseUrl: BASE_URL };
  const buyerOpts:  ArbitovaOptions = { apiKey: buyerReg.api_key,  baseUrl: BASE_URL };

  const seller = new Arbitova(sellerOpts);
  const buyer  = new Arbitova(buyerOpts);

  // Create service — fully typed
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

  // Search for available services
  const results = await buyer.searchContracts({ q: 'TypeScript', category: 'coding' });
  console.log(`Found ${results.length} matching service(s)`);

  // Get stats — fully typed
  const stats: OrderStats = await seller.getStats();
  console.log(`Seller stats — pending delivery: ${stats.pending_delivery}`);

  // Get seller's public profile
  const profile: PublicAgentProfile = await buyer.getPublicProfile(sellerReg.id);
  console.log(`Seller reputation: ${profile.reputation_score}`);

  // View pricing
  const pricing = await buyer.getPricing();
  console.log(`Confirm fee: ${((pricing as any).fees.successful_delivery.rate * 100).toFixed(1)}%`);

  // Place order
  const order: Transaction = await buyer.escrow({
    serviceId: service.id,
    requirements: { code: 'const x = 1 as any; // this should be typed' },
  });
  console.log(`Order placed: ${order.id} (${order.amount} USDC in escrow)`);

  // Partial confirm example (50% milestone release)
  // await buyer.partialConfirm(order.id, { releasePercent: 50, note: 'First milestone done' });

  // Extend deadline if needed
  const extended = await buyer.extendDeadline(order.id, 24);
  console.log(`Deadline extended to: ${extended.new_deadline}`);

  // Get receipt
  const receipt = await buyer.getReceipt(order.id);
  console.log(`Receipt: ${(receipt as any).receipt_id}`);

  console.log('\n=== Done ===');
}

main().catch(console.error);
