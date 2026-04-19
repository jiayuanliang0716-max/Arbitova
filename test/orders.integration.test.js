'use strict';

/**
 * test/orders.integration.test.js — end-to-end HTTP lifecycle.
 *
 * Hits the real routes (agents, services, orders) over a local HTTP server
 * and asserts that every state transition the docs promise actually works.
 *
 * Scenarios:
 *   A.  Register → publish → order → deliver → confirm (happy path)
 *   B.  Register → publish → order → deliver → partial_confirm 60% → confirm
 *   C.  Register → publish → order → cancel before delivery (full refund)
 *   D.  Register → publish → order → deliver → dispute (locks bond)
 *   E.  Dispute seller cooldown: seller cannot dispute <24h after delivering
 *   F.  Scope / auth errors: missing key, invalid key, buy-own-service, price floor
 *   G.  Idempotency-Key replays identical response for POST /orders
 *   H.  Double-confirm: second confirm on a completed order must fail cleanly
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, stopTestApp, request } = require('./helpers/testapp');

let base;

before(async () => {
  const r = await startTestApp();
  base = r.base;
});

after(async () => {
  await stopTestApp();
});

// Helpers
async function registerAgent(name) {
  const r = await request('POST', '/api/v1/agents/register', { body: { name } });
  assert.equal(r.status, 201, `register ${name} failed: ${JSON.stringify(r.body)}`);
  return r.body; // { id, api_key, balance, ... }
}

async function publishService(apiKey, { name = 'test-svc', price = 10, delivery_hours = 24 } = {}) {
  const r = await request('POST', '/api/v1/services', {
    headers: { 'X-API-Key': apiKey },
    body: { name, description: 'integration test service', price, delivery_hours },
  });
  assert.equal(r.status, 201, `publish failed: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function placeOrder(apiKey, service_id, extra = {}) {
  const r = await request('POST', '/api/v1/orders', {
    headers: { 'X-API-Key': apiKey },
    body: { service_id, requirements: 'do the thing', ...extra },
  });
  return r;
}

// ── A. Happy path ─────────────────────────────────────────────────────────
test('A happy path: register → publish → order → deliver → confirm', async () => {
  const seller = await registerAgent('A-seller-' + Date.now());
  const buyer  = await registerAgent('A-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 10 });

  // Order
  const ord = await placeOrder(buyer.api_key, svc.id);
  assert.equal(ord.status, 201, `order failed: ${JSON.stringify(ord.body)}`);
  assert.equal(ord.body.status, 'paid');
  assert.equal(ord.body.amount, 10);

  // Buyer balance should drop by 10, escrow should rise
  const meBuyer = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  assert.ok(parseFloat(meBuyer.body.escrow) >= 10 - 1e-9, `escrow=${meBuyer.body.escrow}`);
  assert.ok(parseFloat(meBuyer.body.balance) <= 90 + 1e-9, `balance=${meBuyer.body.balance}`);

  // Deliver
  const delv = await request('POST', `/api/v1/orders/${ord.body.id}/deliver`, {
    headers: { 'X-API-Key': seller.api_key },
    body: { content: 'here is the work output' },
  });
  assert.equal(delv.status, 200, `deliver failed: ${JSON.stringify(delv.body)}`);
  assert.equal(delv.body.status, 'delivered');

  // Confirm
  const conf = await request('POST', `/api/v1/orders/${ord.body.id}/confirm`, {
    headers: { 'X-API-Key': buyer.api_key },
  });
  assert.equal(conf.status, 200, `confirm failed: ${JSON.stringify(conf.body)}`);
  assert.equal(conf.body.status, 'completed');
  assert.equal(parseFloat(conf.body.platform_fee), 0.05); // 0.5% of 10 = 0.05
  assert.equal(parseFloat(conf.body.seller_received), 9.95);

  // Seller balance +9.95
  const meSeller = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': seller.api_key } });
  assert.ok(parseFloat(meSeller.body.balance) >= 9.95 - 1e-6, `seller balance=${meSeller.body.balance}`);
});

// ── B. Partial-confirm 60% then full confirm ──────────────────────────────
test('B partial confirm 60% then confirm remaining', async () => {
  const seller = await registerAgent('B-seller-' + Date.now());
  const buyer  = await registerAgent('B-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 100 });

  const ord = await placeOrder(buyer.api_key, svc.id);
  assert.equal(ord.status, 201);

  await request('POST', `/api/v1/orders/${ord.body.id}/deliver`, {
    headers: { 'X-API-Key': seller.api_key }, body: { content: 'partial output' },
  });

  // Partial-confirm 60%
  const part = await request('POST', `/api/v1/orders/${ord.body.id}/partial-confirm`, {
    headers: { 'X-API-Key': buyer.api_key },
    body: { percent: 60 },
  });
  assert.equal(part.status, 200, `partial failed: ${JSON.stringify(part.body)}`);
  assert.equal(parseFloat(part.body.amount_released), 60);
  assert.equal(parseFloat(part.body.remaining_locked), 40);
  assert.equal(parseFloat(part.body.platform_fee), 0.3); // 0.5% of 60

  // Now confirm the remaining 40
  const conf = await request('POST', `/api/v1/orders/${ord.body.id}/confirm`, {
    headers: { 'X-API-Key': buyer.api_key },
  });
  assert.equal(conf.status, 200, `final confirm failed: ${JSON.stringify(conf.body)}`);
  assert.equal(parseFloat(conf.body.platform_fee), 0.2); // 0.5% of 40

  // Seller total received: 59.7 (60-0.3) + 39.8 (40-0.2) = 99.5
  const meSeller = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': seller.api_key } });
  assert.ok(parseFloat(meSeller.body.balance) >= 99.5 - 1e-6,
    `seller balance ${meSeller.body.balance} < 99.5`);
});

// ── C. Cancel before delivery ─────────────────────────────────────────────
test('C buyer cancels paid order → full refund', async () => {
  const seller = await registerAgent('C-seller-' + Date.now());
  const buyer  = await registerAgent('C-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 20 });

  const ord = await placeOrder(buyer.api_key, svc.id);
  assert.equal(ord.status, 201);

  const cancel = await request('POST', `/api/v1/orders/${ord.body.id}/cancel`, {
    headers: { 'X-API-Key': buyer.api_key },
  });
  assert.equal(cancel.status, 200, `cancel failed: ${JSON.stringify(cancel.body)}`);

  const me = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  assert.equal(parseFloat(me.body.balance), 100);
  assert.equal(parseFloat(me.body.escrow), 0);
});

// ── D. Dispute locks 5% bond (min 0.01, max 2.0) ──────────────────────────
test('D dispute on delivered order locks bond from buyer balance', async () => {
  const seller = await registerAgent('D-seller-' + Date.now());
  const buyer  = await registerAgent('D-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 20 });

  const ord = await placeOrder(buyer.api_key, svc.id);
  await request('POST', `/api/v1/orders/${ord.body.id}/deliver`, {
    headers: { 'X-API-Key': seller.api_key }, body: { content: 'delivered' },
  });

  // Buyer now has 80 balance, 20 escrow.
  // 5% of 20 = 1.0 bond. Expected: balance 79, escrow 21.
  const disp = await request('POST', `/api/v1/orders/${ord.body.id}/dispute`, {
    headers: { 'X-API-Key': buyer.api_key },
    body: { reason: 'output did not match requirements' },
  });
  assert.equal(disp.status, 201, `dispute failed: ${JSON.stringify(disp.body)}`);
  assert.equal(parseFloat(disp.body.bond_locked), 1.0);

  const me = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  assert.ok(Math.abs(parseFloat(me.body.balance) - 79) < 1e-6,
    `buyer balance ${me.body.balance} expected 79`);
  assert.ok(Math.abs(parseFloat(me.body.escrow) - 21) < 1e-6,
    `buyer escrow ${me.body.escrow} expected 21`);
});

// ── E. Seller cooldown: cannot dispute <24h after delivery ────────────────
test('E seller dispute within 24h of delivery → 400 seller_cooldown_active', async () => {
  const seller = await registerAgent('E-seller-' + Date.now());
  const buyer  = await registerAgent('E-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 20 });

  const ord = await placeOrder(buyer.api_key, svc.id);
  await request('POST', `/api/v1/orders/${ord.body.id}/deliver`, {
    headers: { 'X-API-Key': seller.api_key }, body: { content: 'delivered' },
  });

  const disp = await request('POST', `/api/v1/orders/${ord.body.id}/dispute`, {
    headers: { 'X-API-Key': seller.api_key },
    body: { reason: 'buyer is unresponsive' },
  });
  assert.equal(disp.status, 400, `seller dispute should be blocked: ${JSON.stringify(disp.body)}`);
  assert.equal(disp.body.code, 'seller_cooldown_active');
});

// ── F. Auth / scope / validation errors ───────────────────────────────────
test('F1 missing X-API-Key → 401 missing_api_key', async () => {
  const r = await request('GET', '/api/v1/agents/me');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'missing_api_key');
});

test('F2 invalid X-API-Key → 401 invalid_api_key', async () => {
  const r = await request('GET', '/api/v1/agents/me', {
    headers: { 'X-API-Key': 'definitely-not-a-real-key' },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'invalid_api_key');
});

test('F3 buyer cannot order own service → 400', async () => {
  const a = await registerAgent('F3-' + Date.now());
  const svc = await publishService(a.api_key, { price: 5 });
  const ord = await placeOrder(a.api_key, svc.id);
  assert.equal(ord.status, 400);
});

test('F4 service price below 0.01 USDC floor → 400', async () => {
  const a = await registerAgent('F4-' + Date.now());
  const r = await request('POST', '/api/v1/services', {
    headers: { 'X-API-Key': a.api_key },
    body: { name: 'too-cheap', description: 'x', price: 0.001 },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /0\.01/);
});

test('F5 partial_confirm with pct>=100 → 400', async () => {
  const seller = await registerAgent('F5-seller-' + Date.now());
  const buyer  = await registerAgent('F5-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 10 });
  const ord    = await placeOrder(buyer.api_key, svc.id);
  await request('POST', `/api/v1/orders/${ord.body.id}/deliver`, {
    headers: { 'X-API-Key': seller.api_key }, body: { content: 'done' },
  });
  const r = await request('POST', `/api/v1/orders/${ord.body.id}/partial-confirm`, {
    headers: { 'X-API-Key': buyer.api_key },
    body: { percent: 100 },
  });
  assert.equal(r.status, 400, `pct=100 must be rejected: ${JSON.stringify(r.body)}`);
});

// ── G. Idempotency-Key replays same response ──────────────────────────────
test('G duplicate POST /orders with same Idempotency-Key returns cached response', async () => {
  const seller = await registerAgent('G-seller-' + Date.now());
  const buyer  = await registerAgent('G-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 10 });
  const idem   = 'idem-' + Date.now() + '-' + Math.random();

  const r1 = await request('POST', '/api/v1/orders', {
    headers: { 'X-API-Key': buyer.api_key, 'Idempotency-Key': idem },
    body: { service_id: svc.id, requirements: 'once' },
  });
  assert.equal(r1.status, 201);
  const orderId = r1.body.id;

  // Second call with same key should replay the exact response
  const r2 = await request('POST', '/api/v1/orders', {
    headers: { 'X-API-Key': buyer.api_key, 'Idempotency-Key': idem },
    body: { service_id: svc.id, requirements: 'once' },
  });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.id, orderId, 'should replay same order id');
  assert.equal(r2.headers['x-idempotent-replayed'], 'true');

  // Buyer's escrow should only reflect ONE order, not two
  const me = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  assert.ok(parseFloat(me.body.escrow) <= 10 + 1e-6,
    `escrow doubled (idempotency broke): ${me.body.escrow}`);
});

// ── H. Double-confirm: second call on completed order must 400 ────────────
test('H double-confirm on completed order → 400', async () => {
  const seller = await registerAgent('H-seller-' + Date.now());
  const buyer  = await registerAgent('H-buyer-'  + Date.now());
  const svc    = await publishService(seller.api_key, { price: 10 });
  const ord    = await placeOrder(buyer.api_key, svc.id);
  await request('POST', `/api/v1/orders/${ord.body.id}/deliver`, {
    headers: { 'X-API-Key': seller.api_key }, body: { content: 'done' },
  });

  const c1 = await request('POST', `/api/v1/orders/${ord.body.id}/confirm`, {
    headers: { 'X-API-Key': buyer.api_key },
  });
  assert.equal(c1.status, 200);

  const c2 = await request('POST', `/api/v1/orders/${ord.body.id}/confirm`, {
    headers: { 'X-API-Key': buyer.api_key },
  });
  assert.equal(c2.status, 400, `second confirm should fail: ${JSON.stringify(c2.body)}`);
});
