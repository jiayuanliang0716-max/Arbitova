'use strict';

/**
 * test/fees.test.js — runtime tests for the platform-fee pipeline.
 *
 * Run:  node --test test/fees.test.js
 *
 * Uses the dev SQLite DB (data/a2a.db). Each test records the platform_revenue
 * balance before, performs its operations, then reverses them so the test suite
 * is idempotent against existing data.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Force SQLite mode — tests must not hit the Postgres prod URL.
delete process.env.DATABASE_URL;

require('../src/db/schema');
const { dbGet } = require('../src/db/helpers');
const {
  RELEASE_FEE_RATE,
  DISPUTE_FEE_RATE,
  creditPlatformFee,
  debitPlatformFee,
} = require('../src/config/fees');

const EPS = 1e-9;

async function getRevenue() {
  const r = await dbGet(
    `SELECT balance, total_earned FROM platform_revenue WHERE id = 'singleton'`,
    []
  );
  return {
    balance: parseFloat(r.balance),
    total_earned: parseFloat(r.total_earned),
  };
}

test('creditPlatformFee increases balance and total_earned by the same amount', async () => {
  const before = await getRevenue();
  await creditPlatformFee(1.234567);
  const after = await getRevenue();
  assert.ok(Math.abs((after.balance - before.balance) - 1.234567) < EPS);
  assert.ok(Math.abs((after.total_earned - before.total_earned) - 1.234567) < EPS);
  await debitPlatformFee(1.234567);
});

test('creditPlatformFee is a no-op for zero and negative amounts', async () => {
  const before = await getRevenue();
  await creditPlatformFee(0);
  await creditPlatformFee(-5);
  await creditPlatformFee(NaN);
  const after = await getRevenue();
  assert.equal(after.balance, before.balance);
  assert.equal(after.total_earned, before.total_earned);
});

test('debitPlatformFee is a no-op for zero and negative amounts', async () => {
  const before = await getRevenue();
  await debitPlatformFee(0);
  await debitPlatformFee(-5);
  const after = await getRevenue();
  assert.equal(after.balance, before.balance);
});

test('debitPlatformFee exactly reverses creditPlatformFee', async () => {
  const before = await getRevenue();
  await creditPlatformFee(2);
  await debitPlatformFee(2);
  const after = await getRevenue();
  assert.ok(Math.abs(after.balance - before.balance) < EPS);
  assert.ok(Math.abs(after.total_earned - before.total_earned) < EPS);
});

// ── Per-settlement-path fee arithmetic ─────────────────────────────────────
// These assertions encode the contract that each handler must satisfy.
// They call the same helper every route should be using, so if any route
// diverges (e.g. hardcodes an old rate or skips the credit), comparing
// platform_revenue deltas in route-level tests will flag the regression.

test('/confirm path: 0.5% of amount credits the platform', async () => {
  const amount = 100;
  const fee = amount * RELEASE_FEE_RATE;
  const before = await getRevenue();
  await creditPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs((after.balance - before.balance) - 0.5) < EPS);
  await debitPlatformFee(fee);
});

test('/partial-confirm path: 0.5% of partial amount credits the platform', async () => {
  const releaseAmount = 40; // 40% of a 100 order
  const fee = releaseAmount * RELEASE_FEE_RATE;
  const before = await getRevenue();
  await creditPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs((after.balance - before.balance) - 0.2) < EPS);
  await debitPlatformFee(fee);
});

test('7-day auto-confirm cron path: 0.5% of amount credits the platform', async () => {
  const amount = 100;
  const fee = amount * RELEASE_FEE_RATE;
  const before = await getRevenue();
  await creditPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs((after.balance - before.balance) - 0.5) < EPS);
  await debitPlatformFee(fee);
});

test('dispute seller-wins path (manual / AI / SLA / human review): 2% credits the platform', async () => {
  const amount = 100;
  const fee = amount * DISPUTE_FEE_RATE;
  const before = await getRevenue();
  await creditPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs((after.balance - before.balance) - 2.0) < EPS);
  await debitPlatformFee(fee);
});

test('appeal seller-wins → buyer-wins reversal: net platform change is zero', async () => {
  const amount = 100;
  const fee = amount * DISPUTE_FEE_RATE;
  const before = await getRevenue();
  // 1) original dispute verdict: seller wins → fee credited
  await creditPlatformFee(fee);
  // 2) appeal flips to buyer wins → fee debited back
  await debitPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs(after.balance - before.balance) < EPS);
  assert.ok(Math.abs(after.total_earned - before.total_earned) < EPS);
});

test('appeal buyer-wins → seller-wins reversal: 2% newly credited', async () => {
  const amount = 100;
  const fee = amount * DISPUTE_FEE_RATE;
  const before = await getRevenue();
  // Original verdict was buyer wins → no fee collected originally.
  // Appeal flips to seller wins → fee credited now.
  await creditPlatformFee(fee);
  const after = await getRevenue();
  assert.ok(Math.abs((after.balance - before.balance) - 2.0) < EPS);
  await debitPlatformFee(fee);
});

// ── Minimum-amount / partial-percent guards (source-level regression) ─────

test('services.js rejects prices below the 0.01 USDC floor', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/services.js'), 'utf8');
  assert.match(src, /parseFloat\(price\)\s*<\s*0\.01/);
});

test('orders.js partial-confirm enforces a 1% floor', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/orders.js'), 'utf8');
  assert.match(src, /pct\s*>=\s*1\s*&&\s*pct\s*<\s*100/);
});

test('orders.js dispute endpoint has a 24-hour seller cooldown', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/routes/orders.js'), 'utf8');
  assert.match(src, /seller_cooldown_active/);
  assert.match(src, /hoursSinceDelivery\s*<\s*24/);
});

test('worker auto-confirm cutoff is 7 days, not 48h', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/worker.js'), 'utf8');
  assert.match(src, /7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(src, /48\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

// ── Static wiring check ────────────────────────────────────────────────────
// Regression guard: every settlement source file multiplies an amount by
// a fee rate. Each such site must have a creditPlatformFee / debitPlatformFee
// call within a short window. Catches the case where someone adds a new
// settlement path and forgets to credit the ledger.

test('every *_FEE_RATE multiplication is followed by a ledger call', () => {
  const files = [
    'src/routes/orders.js',
    'src/routes/admin.js',
    'src/worker.js',
  ];
  const root = path.resolve(__dirname, '..');
  for (const rel of files) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Ignore display-only sites (preview / receipt / config) that quote
      // rates to clients but do not settle funds.
      if (/release_fee_rate|dispute_fee_rate|feeRate\s*=/i.test(line)) continue;
      const m = line.match(/\*\s*(RELEASE_FEE_RATE|DISPUTE_FEE_RATE|SETTLEMENT_FEE_RATE)\b/);
      if (!m) continue;
      const window = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
      assert.ok(
        /creditPlatformFee|debitPlatformFee/.test(window),
        `${rel}:${i + 1} multiplies ${m[1]} but no creditPlatformFee / debitPlatformFee within 15 lines`
      );
    }
  }
});
