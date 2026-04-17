#!/usr/bin/env node
'use strict';

/**
 * scripts/backfill-platform-revenue.js
 *
 * Reconstruct the expected platform_revenue.total_earned from historical orders
 * and credit any shortfall. Earlier settlement paths (digital auto-deliver,
 * hash-verified, oracle, 48h auto-confirm, SLA arbitrate, human review) calculated
 * fees but never called creditPlatformFee, so completed orders exist in the DB
 * without a matching revenue credit.
 *
 * Fee rules (must match src/config/fees.js):
 *   completed order + no seller-wins dispute → amount × RELEASE_FEE_RATE
 *   completed order + dispute resolution names seller → amount × DISPUTE_FEE_RATE
 *   refunded / expired → 0
 *
 * Usage:
 *   node scripts/backfill-platform-revenue.js              # dry run, prints diff
 *   node scripts/backfill-platform-revenue.js --apply      # credit the shortfall
 */

require('../src/db/schema');

const { dbAll, dbGet, dbRun } = require('../src/db/helpers');
const { RELEASE_FEE_RATE, DISPUTE_FEE_RATE } = require('../src/config/fees');

const isPostgres = !!process.env.DATABASE_URL;
const apply = process.argv.includes('--apply');

function classifyFee(order, dispute) {
  if (order.status !== 'completed') return 0;
  if (dispute && dispute.resolution) {
    const r = String(dispute.resolution).toLowerCase();
    // Resolutions written by every arbitration path include "winner: seller"
    // (manual dispute) or "seller" in the verdict summary. If unclear, assume
    // non-dispute release — caller can inspect dry-run output.
    if (r.includes('seller')) return parseFloat(order.amount) * DISPUTE_FEE_RATE;
    if (r.includes('buyer')) return 0;
  }
  return parseFloat(order.amount) * RELEASE_FEE_RATE;
}

(async () => {
  const orders = await dbAll(
    `SELECT id, amount, status, completed_at FROM orders WHERE status IN ('completed','refunded')`,
    []
  );

  let expectedEarned = 0;
  const perOrder = [];

  for (const order of orders) {
    const dispute = await dbGet(
      isPostgres
        ? `SELECT resolution FROM disputes WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`
        : `SELECT resolution FROM disputes WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
      [order.id]
    );
    const fee = classifyFee(order, dispute);
    expectedEarned += fee;
    if (fee > 0) perOrder.push({ id: order.id, amount: parseFloat(order.amount), fee, disputed: !!dispute });
  }

  const revenue = await dbGet(`SELECT balance, total_earned FROM platform_revenue WHERE id = 'singleton'`, []);
  const currentEarned = parseFloat(revenue?.total_earned || 0);
  const currentBalance = parseFloat(revenue?.balance || 0);
  const shortfall = expectedEarned - currentEarned;

  console.log('── Backfill report ─────────────────────────────────────');
  console.log(`orders scanned           : ${orders.length}`);
  console.log(`fee-bearing orders       : ${perOrder.length}`);
  console.log(`expected total_earned    : ${expectedEarned.toFixed(6)}`);
  console.log(`current  total_earned    : ${currentEarned.toFixed(6)}`);
  console.log(`current  balance         : ${currentBalance.toFixed(6)}`);
  console.log(`shortfall (to credit)    : ${shortfall.toFixed(6)}`);

  if (shortfall <= 0.000001) {
    console.log('\nNo shortfall — platform_revenue is in sync. Nothing to do.');
    process.exit(0);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to credit the shortfall.');
    console.log('Sample of fee-bearing orders (first 10):');
    perOrder.slice(0, 10).forEach(o => {
      console.log(`  ${o.id}  amount=${o.amount.toFixed(4)}  fee=${o.fee.toFixed(6)}  disputed=${o.disputed}`);
    });
    process.exit(0);
  }

  const nowExpr = isPostgres ? 'NOW()' : "datetime('now')";
  const p = (n) => isPostgres ? `$${n}` : '?';
  await dbRun(
    `UPDATE platform_revenue
       SET balance = balance + ${p(1)},
           total_earned = total_earned + ${p(2)},
           updated_at = ${nowExpr}
     WHERE id = 'singleton'`,
    [shortfall, shortfall]
  );
  console.log(`\nApplied: credited ${shortfall.toFixed(6)} to platform_revenue.`);
  process.exit(0);
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
