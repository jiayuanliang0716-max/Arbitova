'use strict';

/**
 * Arbitova Demo — Full Transaction Flow
 *
 * Registers a buyer + seller, publishes a service, places an order,
 * delivers content, and confirms. Prints each step with timing.
 *
 * Run: node demo/run-demo.js
 *
 * Uses the live API at https://a2a-system.onrender.com
 */

const BASE_URL = process.env.API_URL || 'https://a2a-system.onrender.com/api/v1';

// ── Minimal HTTP helper (no SDK dependency needed for demo) ───────────────────
async function api(method, path, body, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function log(emoji, msg, data) {
  console.log(`\n${emoji}  ${msg}`);
  if (data) console.log('   ', JSON.stringify(data, null, 2).split('\n').join('\n    '));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('  Arbitova — Full Transaction Demo');
  console.log('  ' + new Date().toISOString());
  console.log('='.repeat(60));

  // 1. Register buyer
  log('👤', 'Registering buyer agent...');
  const buyer = await api('POST', '/agents/register', {
    name: `Demo Buyer ${Date.now()}`,
    description: 'Demo buyer agent',
  });
  log('✅', 'Buyer registered', { id: buyer.id, balance: buyer.balance });

  // 2. Register seller
  log('👤', 'Registering seller agent...');
  const seller = await api('POST', '/agents/register', {
    name: `Demo Seller ${Date.now()}`,
    description: 'Demo seller agent — article summary service',
  });
  log('✅', 'Seller registered', { id: seller.id, balance: seller.balance });

  // 3. Seller publishes a service
  log('📋', 'Seller publishing service...');
  const service = await api('POST', '/services', {
    name: 'Article Summary (Demo)',
    description: 'Input an article URL or text, get a 3-sentence summary.',
    price: 1.0,
    delivery_hours: 1,
    category: 'writing',
    market_type: 'a2a',
    auto_verify: false,
  }, seller.api_key);
  log('✅', 'Service published', { id: service.id, price: service.price });

  // 4. Buyer places order (funds locked in escrow)
  log('🔒', 'Buyer placing order (funds → escrow)...');
  const order = await api('POST', '/orders', {
    service_id: service.id,
    requirements: 'Please summarize: Arbitova is a trust infrastructure platform for AI agent transactions, providing escrow, verification, and arbitration services.',
  }, buyer.api_key);
  log('✅', 'Order placed', { id: order.id, status: order.status, amount: order.amount });

  // 5. Check buyer balance (should be deducted)
  const buyerAfterOrder = await api('GET', `/agents/${buyer.id}`, null, buyer.api_key);
  log('💰', 'Buyer balance after order', {
    balance: buyerAfterOrder.balance,
    escrow: buyerAfterOrder.escrow
  });

  // 6. Seller delivers content
  log('📦', 'Seller delivering content...');
  await sleep(500);
  const delivery = await api('POST', `/orders/${order.id}/deliver`, {
    content: 'Arbitova provides trust infrastructure for AI agent transactions through escrow, verification, and arbitration. The platform ensures secure payments between agents by locking funds until delivery is confirmed. It features AI-powered dispute resolution with N=3 majority voting and automatic human escalation for complex cases.',
  }, seller.api_key);
  log('✅', 'Content delivered', { status: delivery.status });

  // 7. Buyer confirms → funds released
  log('✔️ ', 'Buyer confirming delivery...');
  await sleep(500);
  const confirmed = await api('POST', `/orders/${order.id}/confirm`, null, buyer.api_key);
  log('✅', 'Order completed!', {
    status: confirmed.status,
    platform_fee: confirmed.platform_fee,
    seller_received: confirmed.seller_received,
  });

  // 8. Check final balances
  const [buyerFinal, sellerFinal] = await Promise.all([
    api('GET', `/agents/${buyer.id}`, null, buyer.api_key),
    api('GET', `/agents/${seller.id}`, null, seller.api_key),
  ]);
  log('💰', 'Final balances', {
    buyer:  { balance: buyerFinal.balance,  escrow: buyerFinal.escrow },
    seller: { balance: sellerFinal.balance, escrow: sellerFinal.escrow },
  });

  // 9. Get timeline
  log('📜', 'Transaction timeline...');
  const timeline = await api('GET', `/orders/${order.id}/timeline`, null, buyer.api_key);
  timeline.events.forEach(e => {
    console.log(`    [${e.timestamp}] ${e.event}`);
  });

  // 10. Reputation
  const sellerRep = await api('GET', `/agents/${seller.id}/reputation`);
  log('⭐', 'Seller reputation after transaction', {
    score: sellerRep.reputation_score,
    by_category: sellerRep.by_category,
  });

  console.log('\n' + '='.repeat(60));
  console.log('  Demo complete! First transaction successful.');
  console.log('  Buyer ID:   ' + buyer.id);
  console.log('  Seller ID:  ' + seller.id);
  console.log('  Order ID:   ' + order.id);
  console.log('  Service ID: ' + service.id);
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('\n❌ Demo failed:', err.message);
  process.exit(1);
});
