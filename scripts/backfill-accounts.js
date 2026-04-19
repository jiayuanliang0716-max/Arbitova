#!/usr/bin/env node
'use strict';

/**
 * scripts/backfill-accounts.js
 *
 * Phase 2 of account/agent split refactor.
 *
 * Migrates data from the legacy agents table into the new accounts + wallets
 * shape added in Phase 1. Idempotent: safe to re-run.
 *
 * For each agent:
 *   - owner_email present + account_id NULL → create (or reuse) an account
 *     matching that email, set agents.account_id to it
 *   - owner_email NULL + account_id NULL → mark agents.status = 'orphan'
 *   - no wallet row yet → create one, copy balance/escrow/wallet_address/encrypted_key
 *
 * Accounts are de-duplicated by email — multiple agents with the same
 * owner_email collapse into one account (one human owning many agents).
 *
 * Usage:
 *   node scripts/backfill-accounts.js            # dry-run, show what would change
 *   node scripts/backfill-accounts.js --apply    # actually write
 */

require('../src/db/schema');
const { dbAll, dbGet, dbRun } = require('../src/db/helpers');
const crypto = require('crypto');

const isPostgres = !!process.env.DATABASE_URL;
const apply = process.argv.includes('--apply');

function uuid() {
  return crypto.randomUUID();
}

// Build SELECT column list that works on both PG (has supabase_user_id, auth_provider)
// and SQLite (doesn't). We detect once from information_schema / pragma.
async function agentColumns() {
  if (isPostgres) {
    const rows = await dbAll(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'agents'`
    );
    return new Set(rows.map(r => r.column_name));
  }
  const rows = await dbAll(`PRAGMA table_info(agents)`);
  return new Set(rows.map(r => r.name));
}

async function run() {
  console.log(`[backfill] mode=${apply ? 'APPLY' : 'DRY-RUN'} db=${isPostgres ? 'postgres' : 'sqlite'}`);

  const cols = await agentColumns();
  const selectCols = ['id', 'name', 'owner_email', 'balance', 'escrow',
                      'wallet_address', 'wallet_encrypted_key', 'account_id', 'status'];
  if (cols.has('supabase_user_id')) selectCols.push('supabase_user_id');
  if (cols.has('auth_provider')) selectCols.push('auth_provider');

  const agents = await dbAll(`SELECT ${selectCols.join(', ')} FROM agents`);
  console.log(`[backfill] ${agents.length} agents to process\n`);

  // Cache: email → account_id (avoid duplicate inserts for shared emails)
  const accountByEmail = new Map();

  // Preload existing accounts into cache
  const existingAccounts = await dbAll(`SELECT id, email FROM accounts`);
  existingAccounts.forEach(a => accountByEmail.set(a.email, a.id));
  console.log(`[backfill] ${existingAccounts.length} accounts already exist\n`);

  let createdAccounts = 0;
  let linkedAgents = 0;
  let orphaned = 0;
  let createdWallets = 0;

  for (const a of agents) {
    const log = [];

    // ── accounts + agents.account_id ────────────────────────────────────
    if (!a.account_id) {
      if (a.owner_email) {
        let accId = accountByEmail.get(a.owner_email);
        if (!accId) {
          accId = uuid();
          const supabaseId = a.supabase_user_id || `legacy_${accId}`;
          const provider = a.auth_provider || 'legacy';
          if (apply) {
            await dbRun(
              `INSERT INTO accounts (id, supabase_user_id, email, auth_provider)
               VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})`,
              [accId, supabaseId, a.owner_email, provider]
            );
          }
          accountByEmail.set(a.owner_email, accId);
          createdAccounts++;
          log.push(`create account(${a.owner_email})→${accId.slice(0, 8)}`);
        }
        if (apply) {
          await dbRun(`UPDATE agents SET account_id = ${ph(1)} WHERE id = ${ph(2)}`,
                      [accId, a.id]);
        }
        linkedAgents++;
        log.push(`link→account ${accId.slice(0, 8)}`);
      } else if (a.status !== 'orphan') {
        if (apply) {
          await dbRun(`UPDATE agents SET status = 'orphan' WHERE id = ${ph(1)}`, [a.id]);
        }
        orphaned++;
        log.push(`mark orphan (no email)`);
      }
    }

    // ── wallets ─────────────────────────────────────────────────────────
    const wallet = await dbGet(
      `SELECT id FROM wallets WHERE agent_id = ${ph(1)} AND currency = 'USD'`,
      [a.id]
    );
    if (!wallet) {
      if (apply) {
        await dbRun(
          `INSERT INTO wallets (id, agent_id, currency, balance, escrow, address, encrypted_key)
           VALUES (${ph(1)}, ${ph(2)}, 'USD', ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)})`,
          [uuid(), a.id, a.balance || 0, a.escrow || 0,
           a.wallet_address || null, a.wallet_encrypted_key || null]
        );
      }
      createdWallets++;
      log.push(`wallet(bal=${a.balance}, esc=${a.escrow})`);
    }

    console.log(`  [${a.id.slice(0, 8)}] ${a.name.padEnd(24)} ${log.join(' | ')}`);
  }

  console.log(`\n[backfill] summary:`);
  console.log(`  accounts created:  ${createdAccounts}`);
  console.log(`  agents linked:     ${linkedAgents}`);
  console.log(`  agents orphaned:   ${orphaned}`);
  console.log(`  wallets created:   ${createdWallets}`);

  if (!apply) {
    console.log(`\n  (dry-run — nothing was written. Re-run with --apply to commit.)`);
  }
}

// PG uses $1, $2 placeholders; SQLite uses ?
let _phCounter = 0;
function ph(n) { return isPostgres ? `$${n}` : '?'; }

run().then(() => process.exit(0)).catch(e => {
  console.error('[backfill] failed:', e);
  process.exit(1);
});
