'use strict';

/**
 * test/race.test.js — concurrent-request correctness.
 *
 * These tests fire N simultaneous HTTP requests against the same order and
 * assert that the final state is correct. If the money path has a TOCTOU
 * window, these tests catch it.
 *
 * Scenarios:
 *   R1. Double /confirm without Idempotency-Key → only ONE should succeed;
 *       platform fee must be collected exactly once.
 *   R2. Double /confirm WITH same Idempotency-Key → second must replay first;
 *       platform fee collected exactly once.
 *   R3. Parallel /partial-confirm 60% × 2 → one succeeds, second must either
 *       be rejected OR produce total release ≤ 100%.
 *   R4. /deliver + /cancel simultaneously → final status is either 'cancelled'
 *       or 'delivered', never a corrupted in-between. No double-spend.
 *   R5. /dispute + /confirm simultaneously → exactly one wins; money path
 *       matches final status.
 *
 * All tests run on SQLite which has a single-writer lock, so in practice races
 * serialize more than Postgres would. If a bug shows up even on SQLite, it'll
 * be worse in prod.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, stopTestApp, request } = require('./helpers/testapp');
const { dbGet } = require('../src/db/helpers');

let base;
before(async () => { ({ base } = await startTestApp()); });
after(stopTestApp);

async function mkAgent(name) {
  const r = await request('POST', '/api/v1/agents/register', { body: { name } });
  return r.body;
}
async function mkService(apiKey, price = 100) {
  const r = await request('POST', '/api/v1/services', {
    headers: { 'X-API-Key': apiKey },
    body: { name: 'race-svc', description: 'x', price },
  });
  return r.body;
}
async function mkOrder(apiKey, svcId) {
  const r = await request('POST', '/api/v1/orders', {
    headers: { 'X-API-Key': apiKey },
    body: { service_id: svcId, requirements: 'x' },
  });
  return r.body;
}
async function deliver(apiKey, orderId) {
  return request('POST', `/api/v1/orders/${orderId}/deliver`, {
    headers: { 'X-API-Key': apiKey }, body: { content: 'delivered' },
  });
}

async function platformBalance() {
  const r = await dbGet(`SELECT balance FROM platform_revenue WHERE id = 'singleton'`, []);
  return parseFloat(r?.balance || 0);
}

// ── R1. Double confirm (no idempotency key) ───────────────────────────────
test('R1 double /confirm without idempotency key: fee charged exactly once', async () => {
  const seller = await mkAgent('R1-s-' + Date.now());
  const buyer  = await mkAgent('R1-b-' + Date.now());
  const svc    = await mkService(seller.api_key, 100);
  const ord    = await mkOrder(buyer.api_key, svc.id);
  await deliver(seller.api_key, ord.id);

  const platBefore = await platformBalance();

  const [r1, r2] = await Promise.all([
    request('POST', `/api/v1/orders/${ord.id}/confirm`, { headers: { 'X-API-Key': buyer.api_key } }),
    request('POST', `/api/v1/orders/${ord.id}/confirm`, { headers: { 'X-API-Key': buyer.api_key } }),
  ]);

  const platAfter = await platformBalance();
  const delta = platAfter - platBefore;

  // Exactly one confirm must succeed; second must 400. Expected delta = 0.5 (0.5% of 100).
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 400],
    `expected one 200 + one 400, got ${statuses.join(',')}. r1=${JSON.stringify(r1.body)} r2=${JSON.stringify(r2.body)}`);

  assert.ok(Math.abs(delta - 0.5) < 1e-6,
    `FEE DOUBLE-CHARGED: platform delta=${delta}, expected 0.5`);

  // Seller started at 100 (mock mode initial balance) — final must be 199.5, NOT 299.
  const seller2 = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': seller.api_key } });
  assert.ok(parseFloat(seller2.body.balance) <= 199.5 + 1e-6,
    `SELLER DOUBLE-PAID: balance=${seller2.body.balance}, expected ≤ 199.5`);

  // Buyer escrow must never go negative
  const buyer2 = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  assert.ok(parseFloat(buyer2.body.escrow) >= -1e-6,
    `ESCROW NEGATIVE: escrow=${buyer2.body.escrow}`);
});

// ── R2. Double confirm WITH same idempotency key ──────────────────────────
// Note: current /confirm handler does NOT use the idempotency() middleware.
// This test is therefore a behaviour probe; skip gracefully if the key has
// no effect, and just verify fee not double-charged (same as R1).
test('R2 double /confirm with same idempotency key: fee still charged once', async () => {
  const seller = await mkAgent('R2-s-' + Date.now());
  const buyer  = await mkAgent('R2-b-' + Date.now());
  const svc    = await mkService(seller.api_key, 50);
  const ord    = await mkOrder(buyer.api_key, svc.id);
  await deliver(seller.api_key, ord.id);

  const platBefore = await platformBalance();
  const idem = 'r2-' + Date.now();

  const [r1, r2] = await Promise.all([
    request('POST', `/api/v1/orders/${ord.id}/confirm`, {
      headers: { 'X-API-Key': buyer.api_key, 'Idempotency-Key': idem },
    }),
    request('POST', `/api/v1/orders/${ord.id}/confirm`, {
      headers: { 'X-API-Key': buyer.api_key, 'Idempotency-Key': idem },
    }),
  ]);

  const platAfter = await platformBalance();
  const delta = platAfter - platBefore;
  assert.ok(Math.abs(delta - 0.25) < 1e-6, // 0.5% of 50
    `fee drift: ${delta}, expected 0.25. r1=${r1.status} r2=${r2.status}`);
});

// ── R3. Parallel partial-confirm 60% × 2 ──────────────────────────────────
test('R3 parallel /partial-confirm 60% × 2: total release ≤ original amount', async () => {
  const seller = await mkAgent('R3-s-' + Date.now());
  const buyer  = await mkAgent('R3-b-' + Date.now());
  const svc    = await mkService(seller.api_key, 100);
  const ord    = await mkOrder(buyer.api_key, svc.id);
  await deliver(seller.api_key, ord.id);

  const sellerBefore = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': seller.api_key } });

  const [r1, r2] = await Promise.all([
    request('POST', `/api/v1/orders/${ord.id}/partial-confirm`, {
      headers: { 'X-API-Key': buyer.api_key }, body: { percent: 60 },
    }),
    request('POST', `/api/v1/orders/${ord.id}/partial-confirm`, {
      headers: { 'X-API-Key': buyer.api_key }, body: { percent: 60 },
    }),
  ]);

  const sellerAfter = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': seller.api_key } });
  const totalPaidToSeller =
    parseFloat(sellerAfter.body.balance) - parseFloat(sellerBefore.body.balance);

  // Whether one or both succeed, total payout cannot exceed 100 (the escrowed amount).
  // Two 60% releases on separate reads would pay seller 119.4 — that's the bug.
  // Ceiling for valid outcomes: 60 - 0.3 (fee) + remainder fee math ≤ 99.5 net to seller.
  assert.ok(totalPaidToSeller <= 99.5 + 1e-6,
    `OVER-RELEASE: seller got ${totalPaidToSeller}. r1=${r1.status} r2=${r2.status}`);

  // Buyer escrow must not go negative
  const buyerAfter = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  assert.ok(parseFloat(buyerAfter.body.escrow) >= -1e-6,
    `ESCROW NEGATIVE: ${buyerAfter.body.escrow}`);
});

// ── R4. Deliver + cancel race ─────────────────────────────────────────────
test('R4 /deliver + /cancel race: final status is one of {cancelled, delivered}, buyer not double-refunded', async () => {
  const seller = await mkAgent('R4-s-' + Date.now());
  const buyer  = await mkAgent('R4-b-' + Date.now());
  const svc    = await mkService(seller.api_key, 30);
  const ord    = await mkOrder(buyer.api_key, svc.id);

  // Fire deliver (seller) and cancel (buyer) simultaneously
  const [rd, rc] = await Promise.all([
    deliver(seller.api_key, ord.id),
    request('POST', `/api/v1/orders/${ord.id}/cancel`, { headers: { 'X-API-Key': buyer.api_key } }),
  ]);

  const final = await dbGet(`SELECT status FROM orders WHERE id = ?`, [ord.id]);
  assert.ok(['cancelled', 'delivered'].includes(final.status),
    `unexpected final status: ${final.status} (deliver=${rd.status}, cancel=${rc.status})`);

  // Whichever path won, money must not be double-refunded
  const buyer2 = await request('GET', '/api/v1/agents/me', { headers: { 'X-API-Key': buyer.api_key } });
  const bal = parseFloat(buyer2.body.balance);
  const esc = parseFloat(buyer2.body.escrow);

  if (final.status === 'cancelled') {
    // Expect: balance 100, escrow 0 (full refund)
    assert.ok(Math.abs(bal - 100) < 1e-6, `bad cancel balance: ${bal}`);
    assert.ok(Math.abs(esc) < 1e-6, `bad cancel escrow: ${esc}`);
  } else {
    // Expect: balance 70, escrow 30 (locked pending confirm)
    assert.ok(Math.abs(bal - 70) < 1e-6, `bad deliver balance: ${bal}`);
    assert.ok(Math.abs(esc - 30) < 1e-6, `bad deliver escrow: ${esc}`);
  }
});

// ── R5. Dispute + confirm race ────────────────────────────────────────────
test('R5 /dispute + /confirm race: exactly one wins, no double-settlement', async () => {
  const seller = await mkAgent('R5-s-' + Date.now());
  const buyer  = await mkAgent('R5-b-' + Date.now());
  const svc    = await mkService(seller.api_key, 40);
  const ord    = await mkOrder(buyer.api_key, svc.id);
  await deliver(seller.api_key, ord.id);

  const platBefore = await platformBalance();

  const [disp, conf] = await Promise.all([
    request('POST', `/api/v1/orders/${ord.id}/dispute`, {
      headers: { 'X-API-Key': buyer.api_key }, body: { reason: 'bad output' },
    }),
    request('POST', `/api/v1/orders/${ord.id}/confirm`, {
      headers: { 'X-API-Key': buyer.api_key },
    }),
  ]);

  const final = await dbGet(`SELECT status FROM orders WHERE id = ?`, [ord.id]);
  assert.ok(['disputed', 'completed'].includes(final.status),
    `unexpected status: ${final.status}`);

  const platAfter = await platformBalance();
  const delta = platAfter - platBefore;

  if (final.status === 'completed') {
    // Only confirm fee charged
    assert.ok(Math.abs(delta - 0.2) < 1e-6, // 0.5% of 40
      `confirm path: expected 0.2 fee, got ${delta}`);
  } else {
    // No settlement fee yet; dispute is still open
    assert.ok(Math.abs(delta) < 1e-6,
      `dispute path should not have charged fee: ${delta}`);
  }
});
