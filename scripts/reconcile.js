#!/usr/bin/env node
'use strict';

/**
 * scripts/reconcile.js — daily ledger-conservation check.
 *
 * Verifies the money-path invariants that the app is supposed to maintain at
 * all times. Drift here means a bug in the settlement path, not a reporting
 * glitch — investigate immediately.
 *
 * Invariants checked:
 *   (A) Custody   = Σ(agent.balance) + Σ(agent.escrow) + Σ(agent.stake) + platform_revenue.balance
 *   (B) Injected  = (mock mode) 100 × N_agents + Σ(deposits) − Σ(completed withdrawals) − platform_revenue.total_withdrawn
 *                   (chain mode)              Σ(deposits) − Σ(completed withdrawals) − platform_revenue.total_withdrawn
 *   (C) Platform  = platform_revenue.balance = total_earned − total_withdrawn
 *
 *   The custody total (A) must equal the injected total (B).
 *   The platform ledger (C) must be internally consistent.
 *
 * Intended to be run daily by cron. Exits 0 if within tolerance (1e-4),
 * exits 1 if drift exceeds tolerance so the cron mail alerts the operator.
 *
 * Usage:
 *   node scripts/reconcile.js            # human-readable report
 *   node scripts/reconcile.js --json     # machine-readable JSON (for log shippers)
 *   node scripts/reconcile.js --quiet    # only print on drift (cron-friendly)
 */

require('../src/db/schema');

const { dbGet, dbAll } = require('../src/db/helpers');

const TOLERANCE = 1e-4; // sub-cent drift is acceptable (float rounding)
const MOCK_INITIAL_BALANCE = 100.0;

const flagJson  = process.argv.includes('--json');
const flagQuiet = process.argv.includes('--quiet');

function isChainMode() {
  const flag = (process.env.CHAIN_MODE || process.env.A2A_CHAIN_MODE || '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

function n(v) { return parseFloat(v || 0); }

(async () => {
  // Agent-side custody
  const agentsAgg = await dbGet(
    `SELECT COUNT(*)            AS count,
            COALESCE(SUM(balance), 0) AS sum_balance,
            COALESCE(SUM(escrow),  0) AS sum_escrow,
            COALESCE(SUM(stake),   0) AS sum_stake
       FROM agents`,
    []
  );

  // Platform revenue
  const platform = await dbGet(
    `SELECT balance, total_earned, total_withdrawn
       FROM platform_revenue WHERE id = 'singleton'`,
    []
  );

  // Deposits and withdrawals (external money flow)
  const depositsAgg = await dbGet(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM deposits`,
    []
  );
  const withdrawalsAgg = await dbGet(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM withdrawals WHERE status = 'completed'`,
    []
  );

  const numAgents      = parseInt(agentsAgg.count, 10) || 0;
  const sumBalance     = n(agentsAgg.sum_balance);
  const sumEscrow      = n(agentsAgg.sum_escrow);
  const sumStake       = n(agentsAgg.sum_stake);
  const platBalance    = n(platform?.balance);
  const platEarned     = n(platform?.total_earned);
  const platWithdrawn  = n(platform?.total_withdrawn);
  const sumDeposits    = n(depositsAgg.total);
  const sumWithdrawals = n(withdrawalsAgg.total);

  const chain = isChainMode();

  // (A) custody now
  const custody = sumBalance + sumEscrow + sumStake + platBalance;

  // (B) capital injected into the system minus what has left it
  const mockInitial = chain ? 0 : MOCK_INITIAL_BALANCE * numAgents;
  const injected    = mockInitial + sumDeposits - sumWithdrawals - platWithdrawn;

  const custodyDrift  = custody - injected;
  const platformDrift = platBalance - (platEarned - platWithdrawn);

  const custodyOk  = Math.abs(custodyDrift)  <= TOLERANCE;
  const platformOk = Math.abs(platformDrift) <= TOLERANCE;
  const allOk = custodyOk && platformOk;

  const report = {
    timestamp: new Date().toISOString(),
    mode: chain ? 'chain' : 'mock',
    agents: {
      count:       numAgents,
      sum_balance: sumBalance,
      sum_escrow:  sumEscrow,
      sum_stake:   sumStake,
    },
    platform: {
      balance:         platBalance,
      total_earned:    platEarned,
      total_withdrawn: platWithdrawn,
    },
    external: {
      total_deposits:             sumDeposits,
      total_completed_withdrawals: sumWithdrawals,
    },
    invariants: {
      custody_now:       custody,
      capital_injected:  injected,
      custody_drift:     custodyDrift,
      custody_ok:        custodyOk,
      platform_drift:    platformDrift,
      platform_ok:       platformOk,
      all_ok:            allOk,
      tolerance:         TOLERANCE,
    },
  };

  if (flagJson) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!flagQuiet || !allOk) {
    console.log('── Reconciliation report ───────────────────────────────');
    console.log(`timestamp          : ${report.timestamp}`);
    console.log(`mode               : ${report.mode}`);
    console.log(`agents             : count=${numAgents}`);
    console.log(`  Σ balance        : ${sumBalance.toFixed(6)}`);
    console.log(`  Σ escrow         : ${sumEscrow.toFixed(6)}`);
    console.log(`  Σ stake          : ${sumStake.toFixed(6)}`);
    console.log(`platform_revenue   :`);
    console.log(`  balance          : ${platBalance.toFixed(6)}`);
    console.log(`  total_earned     : ${platEarned.toFixed(6)}`);
    console.log(`  total_withdrawn  : ${platWithdrawn.toFixed(6)}`);
    console.log(`external flow      :`);
    console.log(`  Σ deposits       : ${sumDeposits.toFixed(6)}`);
    console.log(`  Σ withdrawals    : ${sumWithdrawals.toFixed(6)}`);
    console.log('── Invariants ──────────────────────────────────────────');
    console.log(`custody now        : ${custody.toFixed(6)}`);
    console.log(`capital injected   : ${injected.toFixed(6)}`);
    console.log(`custody drift      : ${custodyDrift.toFixed(6)}  ${custodyOk  ? 'OK' : 'DRIFT'}`);
    console.log(`platform drift     : ${platformDrift.toFixed(6)}  ${platformOk ? 'OK' : 'DRIFT'}`);
    console.log('────────────────────────────────────────────────────────');
    if (allOk) {
      console.log('Result: OK — ledger conserved within tolerance.');
    } else {
      console.log('Result: DRIFT DETECTED — investigate immediately.');
      if (!custodyOk) {
        console.log(`  custody off by ${custodyDrift.toFixed(6)} USDC`);
        console.log(`  (positive = system is holding more than was injected — possible double-credit)`);
        console.log(`  (negative = system is missing funds — possible double-debit or theft)`);
      }
      if (!platformOk) {
        console.log(`  platform_revenue ledger internally inconsistent by ${platformDrift.toFixed(6)}`);
      }
    }
  }

  process.exit(allOk ? 0 : 1);
})().catch((err) => {
  console.error('Reconcile failed:', err);
  process.exit(2);
});
