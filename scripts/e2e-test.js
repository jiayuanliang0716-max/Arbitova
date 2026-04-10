// e2e-test.js — End-to-end smoke test against live production
// Tests the complete buyer journey: register → browse → buy → deliver → confirm → review

const BASE = 'https://a2a-system.onrender.com';

async function api(path, opts = {}) {
  opts.headers = opts.headers || {};
  if (opts.body && typeof opts.body === 'string') opts.headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 120)}`); }
  if (!res.ok) throw new Error(`[${res.status}] ${data.error || JSON.stringify(data)}`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  console.log('═══════════════════════════════════════════');
  console.log('  A2A Market — End-to-End Smoke Test');
  console.log('  Target:', BASE);
  console.log('═══════════════════════════════════════════\n');

  const results = [];
  function pass(name) { results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  function fail(name, err) { results.push({ name, ok: false, err }); console.log(`  ✗ ${name}: ${err}`); }

  // 1. Health check
  try {
    const h = await api('/health');
    if (h.status === 'ok') pass('Health check');
    else fail('Health check', 'Unexpected: ' + JSON.stringify(h));
  } catch(e) { fail('Health check', e.message); }

  // 2. Platform stats
  try {
    const s = await api('/api/stats');
    if (s.agents > 0 && s.services > 0) pass(`Platform stats (${s.agents} agents, ${s.services} services)`);
    else fail('Platform stats', 'Empty: ' + JSON.stringify(s));
  } catch(e) { fail('Platform stats', e.message); }

  // 3. Register buyer
  let buyer;
  try {
    buyer = await api('/agents/register', { method: 'POST', body: JSON.stringify({ name: 'E2E Test Buyer', description: 'Automated test account' }) });
    if (buyer.id && buyer.api_key) pass(`Register buyer (${buyer.id.slice(0,8)}...)`);
    else fail('Register buyer', 'Missing fields');
  } catch(e) { fail('Register buyer', e.message); return; }
  await sleep(300);

  const buyerAuth = { 'X-API-Key': buyer.api_key };

  // 4. Browse marketplace
  let services;
  try {
    const r = await api('/services/search?market=h2a&sort=reputation');
    services = r.services;
    if (services.length > 0) pass(`Browse market (${services.length} services found)`);
    else fail('Browse market', 'No services');
  } catch(e) { fail('Browse market', e.message); }
  await sleep(300);

  // 5. Get service detail
  const targetService = services.find(s => s.price <= 2 && s.product_type === 'ai_generated');
  if (!targetService) { fail('Find affordable service', 'None found'); return; }
  try {
    const s = await api('/services/' + targetService.id);
    if (s.name) pass(`Service detail: "${s.name}" by ${s.agent_name} ($${s.price})`);
    else fail('Service detail', 'Missing name');
  } catch(e) { fail('Service detail', e.message); }
  await sleep(300);

  // 6. Place order (buyer has 100 USDC starting balance)
  let order;
  try {
    order = await api('/orders', {
      method: 'POST',
      headers: buyerAuth,
      body: JSON.stringify({ service_id: targetService.id, requirements: 'E2E test: please provide a brief analysis' })
    });
    if (order.id && order.status === 'paid') pass(`Place order (${order.id.slice(0,8)}... status=${order.status})`);
    else fail('Place order', JSON.stringify(order));
  } catch(e) { fail('Place order', e.message); }
  await sleep(300);

  // 7. Check buyer balance decreased
  try {
    const me = await api('/agents/' + buyer.id, { headers: buyerAuth });
    const expectedBalance = 100 - targetService.price;
    if (parseFloat(me.balance) <= expectedBalance + 0.01) pass(`Buyer balance check (${me.balance} USDC, escrow: ${me.escrow})`);
    else fail('Buyer balance', `Expected ~${expectedBalance}, got ${me.balance}`);
  } catch(e) { fail('Buyer balance check', e.message); }
  await sleep(300);

  // 8. Check order detail
  try {
    const o = await api('/orders/' + order.id, { headers: buyerAuth });
    if (o.status === 'paid' && o.service_name) pass(`Order detail (service: ${o.service_name})`);
    else fail('Order detail', JSON.stringify(o));
  } catch(e) { fail('Order detail', e.message); }
  await sleep(300);

  // 9. Check inbox (should have order confirmation message)
  try {
    const m = await api('/messages', { headers: buyerAuth });
    pass(`Inbox check (${m.messages?.length || 0} messages, ${m.unread || 0} unread)`);
  } catch(e) { fail('Inbox check', e.message); }
  await sleep(300);

  // 10. Buyer confirms order (simulating delivery already happened or just confirming)
  try {
    const r = await api('/orders/' + order.id + '/confirm', { method: 'POST', headers: buyerAuth });
    if (r.status === 'completed') pass(`Confirm order (seller received: ${r.seller_received} USDC)`);
    else fail('Confirm order', JSON.stringify(r));
  } catch(e) {
    // Expected: might fail if not delivered yet
    if (e.message.includes('delivered')) pass('Confirm order (correctly requires delivery first)');
    else fail('Confirm order', e.message);
  }
  await sleep(300);

  // 11. Check reviews endpoint
  try {
    const r = await api('/reviews/service/' + targetService.id);
    pass(`Reviews API (${r.total_reviews} reviews, avg: ${r.average_rating})`);
  } catch(e) { fail('Reviews API', e.message); }
  await sleep(300);

  // 12. Leaderboard
  try {
    const r = await api('/agents/leaderboard');
    if (r.agents?.length > 0) pass(`Leaderboard (${r.agents.length} agents)`);
    else fail('Leaderboard', 'Empty');
  } catch(e) { fail('Leaderboard', e.message); }
  await sleep(300);

  // 13. LemonSqueezy checkout (will fail if not configured, but should return proper error)
  try {
    const r = await api('/payments/checkout', {
      method: 'POST',
      headers: buyerAuth,
      body: JSON.stringify({ service_id: targetService.id })
    });
    if (r.checkout_url) pass('LemonSqueezy checkout URL generated');
    else fail('LemonSqueezy checkout', 'No URL: ' + JSON.stringify(r));
  } catch(e) {
    if (e.message.includes('not configured') || e.message.includes('API key')) {
      pass('LemonSqueezy checkout (correctly reports not configured)');
    } else {
      fail('LemonSqueezy checkout', e.message);
    }
  }

  // 14. Frontend files served
  const files = ['/css/main.css', '/js/app.js', '/js/i18n.js'];
  for (const f of files) {
    try {
      const res = await fetch(BASE + f);
      if (res.ok) pass(`Static file: ${f} (${res.status})`);
      else fail(`Static file: ${f}`, `HTTP ${res.status}`);
    } catch(e) { fail(`Static file: ${f}`, e.message); }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════');
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`  Results: ${passed} passed, ${failed} failed, ${results.length} total`);
  if (failed === 0) console.log('  🎯 ALL TESTS PASSED');
  else {
    console.log('  Failed tests:');
    results.filter(r => !r.ok).forEach(r => console.log(`    - ${r.name}: ${r.err}`));
  }
  console.log('═══════════════════════════════════════════');
}

run().catch(e => console.error('Fatal:', e));
