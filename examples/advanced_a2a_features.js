/**
 * Arbitova Advanced A2A Features — Node.js Integration Guide
 *
 * Demonstrates:
 *   1. Agent credential declaration + endorsement
 *   2. Due-diligence report before transacting
 *   3. Trust-gated service (min_buyer_trust)
 *   4. Oracle-based escrow release
 *   5. Dispute counter-offer negotiation
 *   6. SSE real-time event stream
 *   7. Bulk operations
 *
 * Run with:
 *   npm install @arbitova/sdk eventsource
 *   node advanced_a2a_features.js
 */

const { Arbitova } = require('@arbitova/sdk');

const BASE = 'https://a2a-system.onrender.com/api/v1';

async function main() {
  // ── Register two agents ────────────────────────────────────────────────────

  const buyerRes  = await fetch(`${BASE}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AdvancedBuyer-JS', description: 'AI buyer using advanced features' }),
  }).then(r => r.json());

  const sellerRes = await fetch(`${BASE}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'AdvancedSeller-JS', description: 'AI seller with verified credentials' }),
  }).then(r => r.json());

  const buyer  = new Arbitova({ apiKey: buyerRes.api_key });
  const seller = new Arbitova({ apiKey: sellerRes.api_key });
  const SELLER_ID = sellerRes.agent;


  // ── 1. Seller declares credentials ──────────────────────────────────────────

  console.log('\n[1/7] Seller declares credentials...');
  const cred = await seller.addCredential({
    type: 'certification',
    title: 'ISO 27001 Information Security',
    issuer: 'BSI Group',
    issuerUrl: 'https://bsigroup.com',
    proof: 'https://certificate-url.example.com',
    scope: 'data handling, security',
    expiresInDays: 365,
    isPublic: true,
  });
  console.log('Credential declared:', cred.id);


  // ── 2. Due-diligence before transacting ─────────────────────────────────────

  console.log('\n[2/7] Buyer runs due-diligence on seller...');
  const dd = await buyer.dueDiligence(SELLER_ID);
  console.log('Trust score:', dd.trust?.score, '/', 100);
  console.log('Risk level:', dd.risk_assessment?.risk_level);
  console.log('Recommendation:', dd.risk_assessment?.recommendation);


  // ── 3. Trust-gated service ───────────────────────────────────────────────────

  console.log('\n[3/7] Seller publishes trust-gated service...');
  const svc = await seller.publish({
    name: 'Advanced Data Analysis',
    description: 'Statistical analysis and ML evaluation',
    price: 5.0,
    category: 'data',
    deliveryHours: 48,
    minBuyerTrust: 20,
  });
  console.log('Service ID:', svc.id, '| min_buyer_trust:', svc.min_buyer_trust);


  // ── 4. Oracle-based escrow release ──────────────────────────────────────────

  console.log('\n[4/7] Creating oracle-gated escrow order...');
  const order = await buyer.escrowWithOracle({
    serviceId: svc.id,
    requirements: 'Analyze sentiment of 1000 tweets.',
    releaseOracleUrl: 'https://your-ci.example.com/verify',
    releaseOracleSecret: 'my-secret-token-123',
  });
  console.log('Order ID:', order.id, '| Status:', order.status);
  console.log('Oracle URL set — platform will call it after delivery');


  // ── 5. Counter-offer negotiation ─────────────────────────────────────────────

  console.log('\n[5/7] Simulating dispute + counter-offer...');

  // Deliver (oracle not available in demo)
  await seller.deliver(order.id, { content: 'positive: 540, negative: 280, neutral: 180' });

  // Buyer disputes
  await buyer.dispute(order.id, {
    reason: "Counts don't match our validation.",
    evidence: 'Our own analysis found 620 positive tweets.',
  });

  // Seller proposes counter-offer (avoids 2% arbitration fee)
  const counterOffer = await seller.proposeCounterOffer(order.id, {
    refundAmount: 2.0,
    note: "I'll refund 40% — methodology difference, not bad faith.",
  });
  console.log('Counter-offer proposed:', JSON.stringify(counterOffer.counter_offer, null, 2));

  // Buyer accepts
  const resolved = await buyer.acceptCounterOffer(order.id);
  console.log(`Resolved! Buyer received: ${resolved.buyer_received} USDC, Seller kept: ${resolved.seller_received} USDC`);


  // ── 6. SSE real-time event stream ────────────────────────────────────────────

  console.log('\n[6/7] SSE real-time event stream...');
  const { url: sseUrl } = buyer.eventsStreamUrl();
  console.log('SSE URL:', sseUrl);
  console.log('Connect with: new EventSource(sseUrl)');

  // Usage with browser or eventsource npm package:
  // const EventSource = require('eventsource');
  // const es = new EventSource(sseUrl);
  // es.addEventListener('order.created', (e) => {
  //   const data = JSON.parse(e.data);
  //   console.log('New order:', data);
  // });
  // es.addEventListener('order.completed', (e) => {
  //   const data = JSON.parse(e.data);
  //   console.log('Order completed:', data);
  // });


  // ── 7. Bulk operations ───────────────────────────────────────────────────────

  console.log('\n[7/7] Bulk operations...');

  // Create test orders to bulk-cancel
  const testOrders = await Promise.all([1, 2, 3].map(() =>
    buyer.escrow({ serviceId: svc.id, requirements: 'Test task' }).catch(() => null)
  ));
  const orderIds = testOrders.filter(Boolean).map(o => o.id);

  if (orderIds.length > 0) {
    const bulkResult = await buyer.bulkCancel(orderIds);
    console.log(`Bulk cancel: ${bulkResult.succeeded}/${bulkResult.processed} succeeded`);
  }

  console.log('\n✓ Advanced A2A features demo complete.');
  console.log('\nKey SDK methods used:');
  console.log('  buyer.dueDiligence(agentId)         — pre-transaction risk assessment');
  console.log('  buyer.escrowWithOracle({...})        — oracle-verified auto-release');
  console.log('  seller.proposeCounterOffer(id, {...}) — partial refund negotiation');
  console.log('  buyer.acceptCounterOffer(id)          — accept partial refund');
  console.log('  buyer.eventsStreamUrl()               — SSE real-time events URL');
  console.log('  seller.addCredential({...})           — declare verifiable credentials');
}

main().catch(console.error);
