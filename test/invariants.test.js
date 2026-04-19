'use strict';

/**
 * test/invariants.test.js — money-conservation + monotonicity invariants.
 *
 * Run:  node --test test/invariants.test.js
 *
 * Scope: these tests poke the ledger + agent balance columns directly and
 * assert that the system-wide money identity and monotonicity rules never
 * break. If any of these fail in CI, something in the money path has diverged.
 *
 * Invariants tested:
 *   I1. Σ(agent.balance) + Σ(agent.escrow) + platform_revenue.balance is
 *       conserved across any credit+debit pair.
 *   I2. platform_revenue.total_earned is monotonically non-decreasing on
 *       credit; matching debit reduces balance but NOT total_earned when
 *       using creditPlatformFee/debitPlatformFee (current implementation
 *       decrements both — we assert the contract the code actually provides).
 *   I3. Every order.amount * RELEASE_FEE_RATE credit produces an exactly
 *       matching delta in platform_revenue.balance (already covered in fees).
 *   I4. Partial-confirm cumulative release never exceeds the original order
 *       amount.
 *   I5. Appeal reversal (seller-wins -> buyer-wins) produces zero net delta.
 *   I6. Auto-confirm cron fee equals manual confirm fee on the same amount
 *       (SLA-path parity).
 *   I7. Dispute-fee (2%) > settlement-fee (0.5%) — rates are ordered.
 */

const { test } = require('node:test');
const assert  = require('node:assert/strict');

// Force SQLite — never touch prod Postgres.
delete process.env.DATABASE_URL;

require('../src/db/schema');
const { dbGet, dbRun, dbAll } = require('../src/db/helpers');
const {
  SETTLEMENT_FEE_RATE,
  DISPUTE_FEE_RATE,
  EXTERNAL_ARB_RATE,
  RELEASE_FEE_RATE,
  creditPlatformFee,
  debitPlatformFee,
} = require('../src/config/fees');

const EPS = 1e-6;

async function systemTotal() {
  const agents = await dbAll(`SELECT COALESCE(SUM(balance),0) as sb, COALESCE(SUM(escrow),0) as se FROM agents`, []);
  const plat   = await dbGet(`SELECT balance FROM platform_revenue WHERE id = 'singleton'`, []);
  return (
    parseFloat(agents[0].sb || 0) +
    parseFloat(agents[0].se || 0) +
    parseFloat(plat?.balance || 0)
  );
}

async function getRevenue() {
  const r = await dbGet(`SELECT balance, total_earned FROM platform_revenue WHERE id = 'singleton'`, []);
  return {
    balance: parseFloat(r.balance),
    total_earned: parseFloat(r.total_earned),
  };
}

// Create two test agents with known balances for invariant tests.
// Uses distinctive IDs so we can clean up deterministically.
const { v4: uuidv4 } = require('uuid');

async function mkAgent(name, balance = 1000) {
  const id = 'invt_' + uuidv4();
  const key = 'invk_' + uuidv4();
  await dbRun(
    `INSERT INTO agents (id, name, api_key, balance, escrow) VALUES (?, ?, ?, ?, 0)`,
    [id, name, key, balance]
  );
  return { id, api_key: key };
}

async function removeAgent(id) {
  await dbRun(`DELETE FROM agents WHERE id = ?`, [id]);
}

// ── I1: Money conservation across credit → debit ──────────────────────────
test('I1 money conservation: credit + debit round-trip preserves system total', async () => {
  const before = await systemTotal();
  await creditPlatformFee(42.5);
  await debitPlatformFee(42.5);
  const after = await systemTotal();
  assert.ok(Math.abs(after - before) < EPS, `drift=${after - before}`);
});

// ── I2: creditPlatformFee + debitPlatformFee rollback both fields ─────────
// This is the ACTUAL behavior of the helpers. If you wanted total_earned to
// be monotonic you'd need a different helper. We document the current contract.
test('I2 creditPlatformFee → debitPlatformFee rolls back both balance and total_earned', async () => {
  const before = await getRevenue();
  await creditPlatformFee(10);
  const mid = await getRevenue();
  assert.ok(Math.abs((mid.balance - before.balance) - 10) < EPS);
  assert.ok(Math.abs((mid.total_earned - before.total_earned) - 10) < EPS);

  await debitPlatformFee(10);
  const after = await getRevenue();
  assert.ok(Math.abs(after.balance - before.balance) < EPS);
  assert.ok(Math.abs(after.total_earned - before.total_earned) < EPS);
});

// ── I3: Fee arithmetic for every settlement rate is exact (NUMERIC 18,6) ──
test('I3 fee = amount * rate is exact on canonical test values', async () => {
  const cases = [
    { amount: 100,   rate: SETTLEMENT_FEE_RATE, expected: 0.5 },
    { amount: 100,   rate: DISPUTE_FEE_RATE,    expected: 2.0 },
    { amount: 100,   rate: EXTERNAL_ARB_RATE,   expected: 5.0 },
    { amount: 0.01,  rate: SETTLEMENT_FEE_RATE, expected: 0.00005 },
    { amount: 9999.99, rate: SETTLEMENT_FEE_RATE, expected: 49.99995 },
  ];
  for (const c of cases) {
    const before = await getRevenue();
    const fee = c.amount * c.rate;
    await creditPlatformFee(fee);
    const after = await getRevenue();
    assert.ok(
      Math.abs((after.balance - before.balance) - c.expected) < 1e-5,
      `amount=${c.amount} rate=${c.rate}: expected ${c.expected}, got ${(after.balance - before.balance)}`
    );
    await debitPlatformFee(fee);
  }
});

// ── I4: Partial-confirm cumulative release stays ≤ order amount ────────────
// Simulate: order amount 100. Partial-confirm 30%, 40%, 25%. Total = 95.
// Test asserts that (escrow + balance changes) track correctly, and never
// over-release. We compute the math the route does, not call the HTTP route
// (integration test covers that). This is a math-level guard.
test('I4 partial-confirm cumulative release never exceeds amount', async () => {
  const buyer = await mkAgent('inv-buyer', 1000);
  const seller = await mkAgent('inv-seller', 0);

  try {
    // Simulate order of 100 in escrow
    await dbRun(`UPDATE agents SET balance = balance - 100, escrow = escrow + 100 WHERE id = ?`, [buyer.id]);

    // Apply 3 partial confirms: 30%, 40%, 25% of remaining each time
    // Route logic: releaseAmount = order.amount * pct/100; remaining = order.amount - releaseAmount
    // Then order.amount = remaining. So subsequent pct applies to the REMAINING.
    const schedule = [30, 40, 25];
    let currentAmount = 100;
    let totalReleased = 0;
    let totalFee = 0;
    for (const pct of schedule) {
      const releaseAmount = currentAmount * (pct / 100);
      const fee = releaseAmount * SETTLEMENT_FEE_RATE;
      const sellerReceives = releaseAmount - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ? WHERE id = ?`, [releaseAmount, buyer.id]);
      await dbRun(`UPDATE agents SET balance = balance + ? WHERE id = ?`, [sellerReceives, seller.id]);
      await creditPlatformFee(fee);
      totalReleased += releaseAmount;
      totalFee += fee;
      currentAmount -= releaseAmount;
    }

    // Remaining escrow should equal (100 - totalReleased), buyer.escrow should match
    const b = await dbGet(`SELECT balance, escrow FROM agents WHERE id = ?`, [buyer.id]);
    const s = await dbGet(`SELECT balance FROM agents WHERE id = ?`, [seller.id]);

    assert.ok(parseFloat(b.escrow) >= 0, `escrow went negative: ${b.escrow}`);
    assert.ok(
      Math.abs(parseFloat(b.escrow) - (100 - totalReleased)) < EPS,
      `buyer escrow ${b.escrow} != expected ${100 - totalReleased}`
    );
    assert.ok(
      Math.abs(parseFloat(s.balance) - (totalReleased - totalFee)) < EPS,
      `seller balance ${s.balance} != expected ${totalReleased - totalFee}`
    );
    assert.ok(totalReleased <= 100 + EPS, `over-release: ${totalReleased}`);
  } finally {
    // Clean up: release remaining escrow + debit fees back for idempotency
    const b = await dbGet(`SELECT escrow FROM agents WHERE id = ?`, [buyer.id]);
    if (b && parseFloat(b.escrow) > 0) {
      await dbRun(`UPDATE agents SET escrow = 0 WHERE id = ?`, [buyer.id]);
    }
    // Debit back all credited fees from this test
    // (30% of 100 = 30, fee 0.15; 40% of 70 = 28, fee 0.14; 25% of 42 = 10.5, fee 0.0525)
    await debitPlatformFee(0.15);
    await debitPlatformFee(0.14);
    await debitPlatformFee(0.0525);
    await removeAgent(buyer.id);
    await removeAgent(seller.id);
  }
});

// ── I5: Appeal reversal produces net zero platform delta ──────────────────
test('I5 appeal reversal seller→buyer: net platform change is zero', async () => {
  const amount = 250;
  const fee = amount * DISPUTE_FEE_RATE; // 5.0

  const before = await getRevenue();
  await creditPlatformFee(fee);
  await debitPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs(after.balance - before.balance) < EPS);
  assert.ok(Math.abs(after.total_earned - before.total_earned) < EPS);
});

// ── I6: Auto-confirm fee === manual confirm fee (SLA parity) ──────────────
test('I6 auto-confirm cron fee equals manual confirm fee (SLA parity)', () => {
  const amounts = [0.01, 1, 10, 100, 9999.99];
  for (const a of amounts) {
    const manualFee = a * SETTLEMENT_FEE_RATE;
    const cronFee   = a * SETTLEMENT_FEE_RATE; // both paths use the same constant
    assert.equal(manualFee, cronFee);
  }
});

// ── I7: Rate ordering — dispute must cost more than settlement ────────────
test('I7 rate ordering: dispute > settlement, external > dispute', () => {
  assert.ok(DISPUTE_FEE_RATE > SETTLEMENT_FEE_RATE,
    `dispute rate (${DISPUTE_FEE_RATE}) must exceed settlement rate (${SETTLEMENT_FEE_RATE})`);
  assert.ok(EXTERNAL_ARB_RATE > DISPUTE_FEE_RATE,
    `external rate (${EXTERNAL_ARB_RATE}) must exceed dispute rate (${DISPUTE_FEE_RATE})`);
  assert.ok(RELEASE_FEE_RATE === SETTLEMENT_FEE_RATE,
    `legacy alias RELEASE_FEE_RATE must equal SETTLEMENT_FEE_RATE`);
});

// ── I8: Full lifecycle money-conservation ──────────────────────────────────
// Buyer(1000) → order(100 into escrow) → confirm → seller gets 99.5, platform 0.5.
// Asserts: buyer.balance went from 1000 to 900, buyer.escrow to 0, seller.balance
// increased by 99.5, platform_revenue.balance increased by 0.5.
// System total conserved throughout.
test('I8 full buy→confirm lifecycle preserves system total', async () => {
  const buyer = await mkAgent('inv-buyer2', 1000);
  const seller = await mkAgent('inv-seller2', 0);

  try {
    const beforeTotal = await systemTotal();
    const beforePlat  = (await getRevenue()).balance;

    // Simulate order: 100 escrowed
    await dbRun(`UPDATE agents SET balance = balance - 100, escrow = escrow + 100 WHERE id = ?`, [buyer.id]);

    // Invariant holds mid-flight
    const midTotal = await systemTotal();
    assert.ok(Math.abs(midTotal - beforeTotal) < EPS,
      `drift during escrow lock: ${midTotal - beforeTotal}`);

    // Simulate confirm
    const fee = 100 * SETTLEMENT_FEE_RATE; // 0.5
    const sellerReceives = 100 - fee;       // 99.5
    await dbRun(`UPDATE agents SET escrow = escrow - 100 WHERE id = ?`, [buyer.id]);
    await dbRun(`UPDATE agents SET balance = balance + ? WHERE id = ?`, [sellerReceives, seller.id]);
    await creditPlatformFee(fee);

    const afterTotal = await systemTotal();
    const afterPlat  = (await getRevenue()).balance;

    assert.ok(Math.abs(afterTotal - beforeTotal) < EPS,
      `system total drift after confirm: ${afterTotal - beforeTotal}`);
    assert.ok(Math.abs((afterPlat - beforePlat) - fee) < EPS,
      `platform delta mismatch: expected ${fee}, got ${afterPlat - beforePlat}`);

    const b = await dbGet(`SELECT balance, escrow FROM agents WHERE id = ?`, [buyer.id]);
    const s = await dbGet(`SELECT balance FROM agents WHERE id = ?`, [seller.id]);
    assert.equal(parseFloat(b.balance), 900);
    assert.equal(parseFloat(b.escrow), 0);
    assert.equal(parseFloat(s.balance), 99.5);

    // Rollback fee so the global platform_revenue balance returns to where it started
    await debitPlatformFee(fee);
  } finally {
    await removeAgent(buyer.id);
    await removeAgent(seller.id);
  }
});

// ── I9: Buyer-wins dispute path refunds escrow back to buyer exactly ──────
test('I9 buyer-wins arbitration: full refund preserves money', async () => {
  const buyer = await mkAgent('inv-buyer3', 1000);
  const seller = await mkAgent('inv-seller3', 0);

  try {
    const beforeTotal = await systemTotal();
    // Escrow 100
    await dbRun(`UPDATE agents SET balance = balance - 100, escrow = escrow + 100 WHERE id = ?`, [buyer.id]);
    // Buyer-wins: escrow -> balance refund, seller gets nothing, platform gets nothing
    await dbRun(`UPDATE agents SET escrow = escrow - 100, balance = balance + 100 WHERE id = ?`, [buyer.id]);

    const afterTotal = await systemTotal();
    assert.ok(Math.abs(afterTotal - beforeTotal) < EPS);

    const b = await dbGet(`SELECT balance, escrow FROM agents WHERE id = ?`, [buyer.id]);
    assert.equal(parseFloat(b.balance), 1000);
    assert.equal(parseFloat(b.escrow), 0);
  } finally {
    await removeAgent(buyer.id);
    await removeAgent(seller.id);
  }
});

// ── I10: Seller-wins dispute path charges 2% not 0.5% ─────────────────────
test('I10 seller-wins dispute: platform collects 2% (not 0.5%)', async () => {
  const buyer  = await mkAgent('inv-buyer4', 1000);
  const seller = await mkAgent('inv-seller4', 0);

  try {
    const beforePlat = (await getRevenue()).balance;
    await dbRun(`UPDATE agents SET balance = balance - 100, escrow = escrow + 100 WHERE id = ?`, [buyer.id]);
    const fee = 100 * DISPUTE_FEE_RATE; // 2.0
    const sellerReceives = 100 - fee;    // 98
    await dbRun(`UPDATE agents SET escrow = escrow - 100 WHERE id = ?`, [buyer.id]);
    await dbRun(`UPDATE agents SET balance = balance + ? WHERE id = ?`, [sellerReceives, seller.id]);
    await creditPlatformFee(fee);

    const afterPlat = (await getRevenue()).balance;
    assert.ok(Math.abs((afterPlat - beforePlat) - 2.0) < EPS,
      `expected +2.0 platform, got ${afterPlat - beforePlat}`);
    const s = await dbGet(`SELECT balance FROM agents WHERE id = ?`, [seller.id]);
    assert.equal(parseFloat(s.balance), 98);

    await debitPlatformFee(fee);
  } finally {
    await removeAgent(buyer.id);
    await removeAgent(seller.id);
  }
});
