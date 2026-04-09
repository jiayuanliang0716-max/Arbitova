/**
 * Stake + Bundle smoke test
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function call(method, path, body, key) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key && { 'X-API-Key': key }) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('PASS:', msg);
}

async function run() {
  console.log('\n=== Stake + Bundle smoke test ===\n');

  const admin = process.env.ADMIN_KEY = 'test_admin_key_for_resolve';
  // Stake flow
  const a = (await call('POST', '/agents/register', { name: 'Staker' })).data;
  let r;
  r = await call('POST', '/agents/stake', { amount: 30 }, a.api_key);
  assert(r.status === 200 && parseFloat(r.data.stake) === 30, 'stake 30 USDC');
  assert(parseFloat(r.data.balance) === 70, 'balance reduced to 70');

  r = await call('POST', '/agents/stake', { amount: 999 }, a.api_key);
  assert(r.status === 400, 'reject stake beyond balance');

  r = await call('POST', '/agents/unstake', { amount: 10 }, a.api_key);
  assert(parseFloat(r.data.stake) === 20 && parseFloat(r.data.balance) === 80, 'unstake 10 OK');

  // min_seller_stake gating
  const seller = (await call('POST', '/agents/register', { name: 'GatedSeller' })).data;
  // Try to list a service requiring stake you don't have
  r = await call('POST', '/services', { name: 'Gated', price: 5, min_seller_stake: 50 }, seller.api_key);
  assert(r.status === 400, 'reject service listing with stake gate above seller stake');

  await call('POST', '/agents/stake', { amount: 50 }, seller.api_key);
  r = await call('POST', '/services', { name: 'Gated', price: 5, min_seller_stake: 50 }, seller.api_key);
  assert(r.status === 201, 'list gated service after staking');
  const gatedSvcId = r.data.id;

  // Buyer attempts to buy from gated seller — should work
  const buyer = (await call('POST', '/agents/register', { name: 'GatedBuyer' })).data;
  r = await call('POST', '/orders', { service_id: gatedSvcId }, buyer.api_key);
  assert(r.status === 201, 'buy from stake-gated seller');

  // Bundle flow
  // Publish 3 simple services from distinct sellers
  const s1 = (await call('POST', '/agents/register', { name: 'Bs1' })).data;
  const s2 = (await call('POST', '/agents/register', { name: 'Bs2' })).data;
  const s3 = (await call('POST', '/agents/register', { name: 'Bs3' })).data;
  const v1 = (await call('POST', '/services', { name: 'One',   price: 5 }, s1.api_key)).data;
  const v2 = (await call('POST', '/services', { name: 'Two',   price: 7 }, s2.api_key)).data;
  const v3 = (await call('POST', '/services', { name: 'Three', price: 3 }, s3.api_key)).data;

  const b = (await call('POST', '/agents/register', { name: 'Bundler' })).data; // 100 USDC
  r = await call('POST', '/orders/bundle', { items: [
    { service_id: v1.id }, { service_id: v2.id }, { service_id: v3.id }
  ]}, b.api_key);
  assert(r.status === 201, 'create 3-item bundle');
  assert(parseFloat(r.data.total_amount) === 15, 'total amount = 15');
  assert(r.data.order_ids.length === 3, '3 child orders');

  // Buyer balance should be 100 - 15 = 85
  const bInfo = await call('GET', `/agents/${b.id}`, null, b.api_key);
  assert(parseFloat(bInfo.data.balance) === 85, 'balance deducted for bundle');
  assert(parseFloat(bInfo.data.escrow) === 15, 'escrow increased for bundle');

  // Insufficient-balance bundle should roll back entirely
  // Balance is 85; build a bundle costing > 85 USDC (20 x v2 = 140)
  const bigItems = [];
  for (let i = 0; i < 20; i++) bigItems.push({ service_id: v2.id });
  r = await call('POST', '/orders/bundle', { items: bigItems }, b.api_key);
  assert(r.status === 400, 'reject bundle exceeding balance');

  const bInfo2 = await call('GET', `/agents/${b.id}`, null, b.api_key);
  assert(parseFloat(bInfo2.data.balance) === 85, 'balance unchanged after failed bundle (no partial)');

  // Bundle GET
  const bundleId = (await call('POST', '/orders/bundle', { items: [{ service_id: v1.id }] }, b.api_key)).data.bundle_id;
  const bg = await call('GET', `/orders/bundle/${bundleId}`, null, b.api_key);
  assert(bg.status === 200, 'get bundle');
  assert(bg.data.children.length === 1, 'bundle has 1 child');

  console.log('\nAll stake+bundle tests passed ✓\n');
}
run().catch(e => { console.error('Test crashed:', e); process.exit(1); });
