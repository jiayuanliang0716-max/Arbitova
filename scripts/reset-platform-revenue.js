#!/usr/bin/env node
'use strict';

/**
 * scripts/reset-platform-revenue.js
 *
 * Zero out the platform_revenue singleton. Intended for pre-launch only —
 * when all historical orders are test traffic and the ledger has no real
 * revenue to preserve. Running this on a post-launch DB destroys accounting
 * history.
 *
 * Usage:
 *   node scripts/reset-platform-revenue.js              # dry run, prints current values
 *   node scripts/reset-platform-revenue.js --apply      # reset balance + total_earned to 0
 */

require('../src/db/schema');

const { dbGet, dbRun } = require('../src/db/helpers');

const isPostgres = !!process.env.DATABASE_URL;
const apply = process.argv.includes('--apply');

(async () => {
  const revenue = await dbGet(
    `SELECT balance, total_earned, updated_at FROM platform_revenue WHERE id = 'singleton'`,
    []
  );

  const currentBalance = parseFloat(revenue?.balance || 0);
  const currentEarned = parseFloat(revenue?.total_earned || 0);

  console.log('── Reset report ────────────────────────────────────────');
  console.log(`current balance          : ${currentBalance.toFixed(6)}`);
  console.log(`current total_earned     : ${currentEarned.toFixed(6)}`);
  console.log(`last updated             : ${revenue?.updated_at || 'never'}`);

  if (currentBalance === 0 && currentEarned === 0) {
    console.log('\nAlready zero. Nothing to do.');
    process.exit(0);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to zero both fields.');
    console.log('WARNING: this wipes accounting history. Only run pre-launch.');
    process.exit(0);
  }

  const nowExpr = isPostgres ? 'NOW()' : "datetime('now')";
  await dbRun(
    `UPDATE platform_revenue
        SET balance = 0,
            total_earned = 0,
            updated_at = ${nowExpr}
      WHERE id = 'singleton'`,
    []
  );

  console.log(`\nApplied: reset balance and total_earned to 0.`);
  console.log(`Previous values preserved only in this log output.`);
  process.exit(0);
})().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
