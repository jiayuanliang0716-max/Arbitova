'use strict';
/**
 * src/path_b/db.js
 *
 * Minimal DB adapter for Path B. Shares the same underlying connection pool /
 * SQLite handle as Path A (src/db/schema.js + src/db/helpers.js) so we do not
 * open a second connection.  Re-exports the helpers under path_b-friendly names
 * and adds path_b-specific query functions.
 *
 * DO NOT import this from any Path A file.
 */

const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun, p } = require('../db/helpers');
const db = require('../db/schema');

const isPg = () => db.type === 'pg';

// ---------------------------------------------------------------------------
// Schema bootstrap (idempotent — safe to call on every startup)
// ---------------------------------------------------------------------------
async function ensureSchema() {
  const fs = require('fs');
  const path = require('path');
  const suffix = isPg() ? 'pg' : 'sqlite';
  const file = path.resolve(
    __dirname,
    '../../migrations/path_b/001_escrow_tables.' + suffix + '.sql'
  );
  const sql = fs.readFileSync(file, 'utf8');
  // Split on statement boundaries (double-newline after semicolon is safe enough)
  const stmts = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of stmts) {
    await dbRun(stmt + (stmt.endsWith(';') ? '' : ';'), []);
  }
}

// ---------------------------------------------------------------------------
// path_b_escrows
// ---------------------------------------------------------------------------
async function upsertEscrow(data) {
  // data must contain: escrow_id, tx_hash, buyer_address, seller_address,
  //   amount, delivery_deadline, state, verification_uri
  const now = new Date().toISOString();
  const id = uuidv4();

  if (isPg()) {
    await dbRun(
      `INSERT INTO path_b_escrows
         (id, escrow_id, tx_hash, buyer_address, seller_address, amount,
          delivery_deadline, review_deadline, state, delivery_hash,
          delivery_payload_uri, verification_uri, buyer_email, seller_email,
          verdict_hash, resolved_buyer_bps, resolved_seller_bps,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (escrow_id) DO UPDATE SET
         state                = EXCLUDED.state,
         tx_hash              = COALESCE(EXCLUDED.tx_hash, path_b_escrows.tx_hash),
         review_deadline      = COALESCE(EXCLUDED.review_deadline, path_b_escrows.review_deadline),
         delivery_hash        = COALESCE(EXCLUDED.delivery_hash, path_b_escrows.delivery_hash),
         delivery_payload_uri = COALESCE(EXCLUDED.delivery_payload_uri, path_b_escrows.delivery_payload_uri),
         verdict_hash         = COALESCE(EXCLUDED.verdict_hash, path_b_escrows.verdict_hash),
         resolved_buyer_bps   = COALESCE(EXCLUDED.resolved_buyer_bps, path_b_escrows.resolved_buyer_bps),
         resolved_seller_bps  = COALESCE(EXCLUDED.resolved_seller_bps, path_b_escrows.resolved_seller_bps),
         buyer_email          = COALESCE(EXCLUDED.buyer_email, path_b_escrows.buyer_email),
         seller_email         = COALESCE(EXCLUDED.seller_email, path_b_escrows.seller_email),
         updated_at           = EXCLUDED.updated_at`,
      [
        id, data.escrow_id, data.tx_hash, data.buyer_address, data.seller_address,
        String(data.amount), data.delivery_deadline, data.review_deadline || null,
        data.state, data.delivery_hash || null, data.delivery_payload_uri || null,
        data.verification_uri || null, data.buyer_email || null, data.seller_email || null,
        data.verdict_hash || null, data.resolved_buyer_bps ?? null,
        data.resolved_seller_bps ?? null, now, now,
      ]
    );
  } else {
    // SQLite: INSERT OR REPLACE for simplicity (re-generates UUID on conflict, acceptable for dev)
    await dbRun(
      `INSERT OR REPLACE INTO path_b_escrows
         (id, escrow_id, tx_hash, buyer_address, seller_address, amount,
          delivery_deadline, review_deadline, state, delivery_hash,
          delivery_payload_uri, verification_uri, buyer_email, seller_email,
          verdict_hash, resolved_buyer_bps, resolved_seller_bps,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, data.escrow_id, data.tx_hash, data.buyer_address, data.seller_address,
        String(data.amount), data.delivery_deadline, data.review_deadline || null,
        data.state, data.delivery_hash || null, data.delivery_payload_uri || null,
        data.verification_uri || null, data.buyer_email || null, data.seller_email || null,
        data.verdict_hash || null, data.resolved_buyer_bps ?? null,
        data.resolved_seller_bps ?? null, now, now,
      ]
    );
  }
}

async function getEscrow(escrowId) {
  return dbGet(
    `SELECT * FROM path_b_escrows WHERE escrow_id = ${p(1)}`,
    [escrowId]
  );
}

async function getExpiredDeliveredEscrows() {
  // SQLite stores review_deadline as ISO-8601 with 'T' and 'Z' (e.g. '2026-04-20T21:00:00.000Z').
  // datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (no T/Z), so direct comparison fails.
  // We normalise by replacing 'T' with ' ' and stripping 'Z' for SQLite string comparison.
  const cmp = isPg()
    ? "review_deadline < NOW()"
    : "replace(replace(review_deadline,'T',' '),'Z','') < datetime('now')";
  return dbAll(
    `SELECT * FROM path_b_escrows WHERE state = 'DELIVERED' AND ${cmp}`,
    []
  );
}

async function updateEscrowState(escrowId, updates) {
  // updates: partial object of columns to change
  const fields = Object.keys(updates);
  if (!fields.length) return;

  const cols = fields.map((f, i) => `${f} = ${p(i + 1)}`).join(', ');
  const vals = fields.map((f) => updates[f]);
  const now = new Date().toISOString();
  vals.push(now);
  vals.push(escrowId);

  await dbRun(
    `UPDATE path_b_escrows SET ${cols}, updated_at = ${p(fields.length + 1)} WHERE escrow_id = ${p(fields.length + 2)}`,
    vals
  );
}

// ---------------------------------------------------------------------------
// path_b_events
// ---------------------------------------------------------------------------
async function insertEvent(data) {
  // data: escrow_id, event_name, block_number, tx_hash, log_index, payload (obj)
  const id = uuidv4();
  const payloadStr = isPg() ? data.payload : JSON.stringify(data.payload);
  const now = new Date().toISOString();

  if (isPg()) {
    await dbRun(
      `INSERT INTO path_b_events
         (id, escrow_id, event_name, block_number, tx_hash, log_index, payload, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [id, data.escrow_id, data.event_name, data.block_number,
       data.tx_hash, data.log_index, payloadStr, now]
    );
  } else {
    await dbRun(
      `INSERT OR IGNORE INTO path_b_events
         (id, escrow_id, event_name, block_number, tx_hash, log_index, payload, processed_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, data.escrow_id, data.event_name, data.block_number,
       data.tx_hash, data.log_index, payloadStr, now]
    );
  }
}

// ---------------------------------------------------------------------------
// path_b_indexer_cursor
// ---------------------------------------------------------------------------
async function getCursor(chainId) {
  return dbGet(
    `SELECT * FROM path_b_indexer_cursor WHERE chain_id = ${p(1)}`,
    [chainId]
  );
}

async function setCursor(chainId, contractAddress, lastBlock) {
  const now = new Date().toISOString();
  if (isPg()) {
    await dbRun(
      `INSERT INTO path_b_indexer_cursor (chain_id, contract_address, last_block, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain_id) DO UPDATE SET last_block = $3, updated_at = $4`,
      [chainId, contractAddress, lastBlock, now]
    );
  } else {
    await dbRun(
      `INSERT OR REPLACE INTO path_b_indexer_cursor (chain_id, contract_address, last_block, updated_at)
       VALUES (?,?,?,?)`,
      [chainId, contractAddress, lastBlock, now]
    );
  }
}

// ---------------------------------------------------------------------------
// path_b_notifications
// ---------------------------------------------------------------------------
async function insertNotification(data) {
  const id = uuidv4();
  const now = new Date().toISOString();
  if (isPg()) {
    await dbRun(
      `INSERT INTO path_b_notifications
         (id, escrow_id, event_name, channel, recipient, status, attempt_count, created_at)
       VALUES ($1,$2,$3,$4,$5,'pending',0,$6)`,
      [id, data.escrow_id, data.event_name, data.channel, data.recipient, now]
    );
  } else {
    await dbRun(
      `INSERT INTO path_b_notifications
         (id, escrow_id, event_name, channel, recipient, status, attempt_count, created_at)
       VALUES (?,?,?,?,?,'pending',0,?)`,
      [id, data.escrow_id, data.event_name, data.channel, data.recipient, now]
    );
  }
  return id;
}

async function updateNotification(id, updates) {
  const fields = Object.keys(updates);
  if (!fields.length) return;
  const cols = fields.map((f, i) => `${f} = ${p(i + 1)}`).join(', ');
  const vals = [...fields.map((f) => updates[f]), id];
  await dbRun(
    `UPDATE path_b_notifications SET ${cols} WHERE id = ${p(fields.length + 1)}`,
    vals
  );
}

module.exports = {
  ensureSchema,
  upsertEscrow,
  getEscrow,
  getExpiredDeliveredEscrows,
  updateEscrowState,
  insertEvent,
  getCursor,
  setCursor,
  insertNotification,
  updateNotification,
};
