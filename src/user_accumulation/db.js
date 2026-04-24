'use strict';
/**
 * src/user_accumulation/db.js
 *
 * User accumulation storage adapter. Shares the Path A DB pool via
 * src/db/helpers. Design doc: docs/user-accumulation-system.md.
 *
 * Public surface:
 *   ensureSchema()        — run the migration idempotently on startup
 *   insertEvent(evt)      — append one row to user_events
 *   resolveAndUpsertEntity(evt) — identity resolution + user_entities upsert
 *   listEntities(opts)    — admin listing
 *   listEvents(opts)      — admin event tail
 *   recordOutreach(row)   — insert into outreach_log
 *   attribution.*         — issue/verify/revoke/list attribution keys
 *   recordGithubSnapshot(row) — insert into github_snapshots
 */

const crypto = require('crypto');
const { dbGet, dbAll, dbRun, p } = require('../db/helpers');
const db = require('../db/schema');

const isPg = () => db.type === 'pg';

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------
async function ensureSchema() {
  const fs = require('fs');
  const path = require('path');
  const suffix = isPg() ? 'pg' : 'sqlite';
  const file = path.resolve(
    __dirname,
    '../../migrations/user_accumulation/001_user_events.' + suffix + '.sql'
  );
  const sql = fs.readFileSync(file, 'utf8');
  const stmts = sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (const stmt of stmts) {
    await dbRun(stmt + (stmt.endsWith(';') ? '' : ';'), []);
  }
}

// ---------------------------------------------------------------------------
// Heat scoring — single source of truth
// ---------------------------------------------------------------------------
const HEAT_POINTS = {
  site_visit: 1,
  docs_visit: 2,
  api_probe: 3,
  sdk_install: 20,
  mcp_install: 20,
  api_call: 5,
  escrow_create_sepolia: 30,
  escrow_create_mainnet: 100,
  github_star: 10,
  github_fork: 30,
  github_issue: 50,
  github_pr: 80,
  discord_msg: 15,
  cold_dm_reply: 40,
  attribution_signup: 60,
  attribution_verified: 80,
};

function heatFor(event_type) {
  return HEAT_POINTS[event_type] || 0;
}

// State transitions — applied in resolveAndUpsertEntity.
function stateFor(totalHeat, prevState) {
  if (prevState === 'customer' || prevState === 'reference' || prevState === 'ignored') return prevState;
  if (totalHeat >= 100) return 'hot';
  if (totalHeat >= 20) return 'warm';
  return 'cold';
}

// ---------------------------------------------------------------------------
// Event capture
// ---------------------------------------------------------------------------
async function insertEvent(evt) {
  const heat = evt.heat_points != null ? evt.heat_points : heatFor(evt.event_type);
  const metaJson = isPg() ? (evt.metadata || {}) : JSON.stringify(evt.metadata || {});

  if (isPg()) {
    await dbRun(
      `INSERT INTO user_events
         (event_type, ip_hash, wallet, github, email, api_key_id, path, referrer, ua_family, metadata, heat_points)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        evt.event_type,
        evt.ip_hash || null,
        evt.wallet ? evt.wallet.toLowerCase() : null,
        evt.github || null,
        evt.email ? evt.email.toLowerCase() : null,
        evt.api_key_id || null,
        evt.path || null,
        evt.referrer || null,
        evt.ua_family || null,
        metaJson,
        heat,
      ]
    );
  } else {
    await dbRun(
      `INSERT INTO user_events
         (event_type, ip_hash, wallet, github, email, api_key_id, path, referrer, ua_family, metadata, heat_points)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        evt.event_type,
        evt.ip_hash || null,
        evt.wallet ? evt.wallet.toLowerCase() : null,
        evt.github || null,
        evt.email ? evt.email.toLowerCase() : null,
        evt.api_key_id || null,
        evt.path || null,
        evt.referrer || null,
        evt.ua_family || null,
        metaJson,
        heat,
      ]
    );
  }
  return heat;
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------
// Order of authority: wallet > github > api_key_id > ip_hash.
// The first non-null of these becomes the entity id, prefixed with its kind.
function entityIdFor(evt) {
  if (evt.wallet)     return `wallet:${evt.wallet.toLowerCase()}`;
  if (evt.github)     return `github:${evt.github}`;
  if (evt.api_key_id) return `apikey:${evt.api_key_id}`;
  if (evt.ip_hash)    return `ip:${evt.ip_hash}`;
  return null;
}

// Postgres uses array columns; SQLite stores JSON-encoded arrays in TEXT.
function encodeArray(arr) {
  return isPg() ? arr : JSON.stringify(arr || []);
}

function decodeArray(val) {
  if (val == null) return [];
  if (Array.isArray(val)) return val;
  try { return JSON.parse(val); } catch { return []; }
}

async function resolveAndUpsertEntity(evt, heatDelta) {
  const id = entityIdFor(evt);
  if (!id) return null;

  const existing = await dbGet(`SELECT * FROM user_entities WHERE id = ${p(1)}`, [id]);
  const now = new Date().toISOString();

  if (!existing) {
    const wallets     = evt.wallet ? [evt.wallet.toLowerCase()] : [];
    const githubs     = evt.github ? [evt.github] : [];
    const emails      = evt.email ? [evt.email.toLowerCase()] : [];
    const api_key_ids = evt.api_key_id ? [evt.api_key_id] : [];
    const ip_hashes   = evt.ip_hash ? [evt.ip_hash] : [];
    const totalHeat = heatDelta || 0;
    const newState = stateFor(totalHeat, 'cold');

    if (isPg()) {
      await dbRun(
        `INSERT INTO user_entities
           (id, first_seen, last_seen, total_heat, state,
            wallets, githubs, emails, api_key_ids, ip_hashes, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, now, now, totalHeat, newState, wallets, githubs, emails, api_key_ids, ip_hashes, now]
      );
    } else {
      await dbRun(
        `INSERT INTO user_entities
           (id, first_seen, last_seen, total_heat, state,
            wallets, githubs, emails, api_key_ids, ip_hashes, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, now, now, totalHeat, newState,
         encodeArray(wallets), encodeArray(githubs), encodeArray(emails),
         encodeArray(api_key_ids), encodeArray(ip_hashes), now]
      );
    }
    return { id, state: newState, created: true };
  }

  // Merge identifiers; preserve existing state unless heat pushes us up.
  const mergedWallets   = mergeArr(decodeArray(existing.wallets),     evt.wallet ? evt.wallet.toLowerCase() : null);
  const mergedGithubs   = mergeArr(decodeArray(existing.githubs),     evt.github || null);
  const mergedEmails    = mergeArr(decodeArray(existing.emails),      evt.email ? evt.email.toLowerCase() : null);
  const mergedApiKeys   = mergeArr(decodeArray(existing.api_key_ids), evt.api_key_id || null);
  const mergedIpHashes  = mergeArr(decodeArray(existing.ip_hashes),   evt.ip_hash || null);
  const newTotal = (existing.total_heat || 0) + (heatDelta || 0);
  const newState = stateFor(newTotal, existing.state);

  if (isPg()) {
    await dbRun(
      `UPDATE user_entities
         SET last_seen = $1,
             total_heat = $2,
             state = $3,
             wallets = $4,
             githubs = $5,
             emails = $6,
             api_key_ids = $7,
             ip_hashes = $8,
             updated_at = $9
       WHERE id = $10`,
      [now, newTotal, newState, mergedWallets, mergedGithubs, mergedEmails,
       mergedApiKeys, mergedIpHashes, now, id]
    );
  } else {
    await dbRun(
      `UPDATE user_entities
         SET last_seen = ?,
             total_heat = ?,
             state = ?,
             wallets = ?,
             githubs = ?,
             emails = ?,
             api_key_ids = ?,
             ip_hashes = ?,
             updated_at = ?
       WHERE id = ?`,
      [now, newTotal, newState,
       encodeArray(mergedWallets), encodeArray(mergedGithubs),
       encodeArray(mergedEmails), encodeArray(mergedApiKeys),
       encodeArray(mergedIpHashes), now, id]
    );
  }
  return { id, state: newState, created: false };
}

function mergeArr(existingArr, newVal) {
  if (!newVal) return existingArr;
  if (existingArr.includes(newVal)) return existingArr;
  return [...existingArr, newVal];
}

// ---------------------------------------------------------------------------
// Admin listing
// ---------------------------------------------------------------------------
async function listEntities({ limit = 200, state = null, minHeat = 0 } = {}) {
  const conds = ['total_heat >= ' + Number(minHeat)];
  const params = [];
  if (state) {
    conds.push(`state = ${p(params.length + 1)}`);
    params.push(state);
  }
  const sql =
    `SELECT id, first_seen, last_seen, total_heat, state,
            wallets, githubs, emails, api_key_ids, project_name, project_url
       FROM user_entities
      WHERE ${conds.join(' AND ')}
      ORDER BY total_heat DESC, last_seen DESC
      LIMIT ${Number(limit)}`;
  const rows = await dbAll(sql, params);
  return rows.map((r) => ({
    ...r,
    wallets:     decodeArray(r.wallets),
    githubs:     decodeArray(r.githubs),
    emails:      decodeArray(r.emails),
    api_key_ids: decodeArray(r.api_key_ids),
  }));
}

async function listEvents({ limit = 200, entityId = null } = {}) {
  if (!entityId) {
    return dbAll(
      `SELECT id, ts, event_type, wallet, github, api_key_id, ip_hash, path, heat_points
         FROM user_events ORDER BY ts DESC LIMIT ${Number(limit)}`
    );
  }
  // entity id format: "wallet:0x...", "github:foo", "apikey:...", "ip:..."
  const [kind, value] = entityId.split(':');
  const col = kind === 'wallet' ? 'wallet'
          : kind === 'github' ? 'github'
          : kind === 'apikey' ? 'api_key_id'
          : kind === 'ip' ? 'ip_hash'
          : null;
  if (!col) return [];
  return dbAll(
    `SELECT id, ts, event_type, wallet, github, api_key_id, ip_hash, path, heat_points
       FROM user_events
      WHERE ${col} = ${p(1)}
      ORDER BY ts DESC LIMIT ${Number(limit)}`,
    [value]
  );
}

// ---------------------------------------------------------------------------
// Outreach log
// ---------------------------------------------------------------------------
async function recordOutreach({ channel, target, target_kind, subject, body_excerpt, response, entity_id, metadata }) {
  const metaJson = isPg() ? (metadata || {}) : JSON.stringify(metadata || {});
  if (isPg()) {
    await dbRun(
      `INSERT INTO outreach_log (channel, target, target_kind, subject, body_excerpt, response, entity_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [channel, target, target_kind, subject || null, body_excerpt || null, response || null, entity_id || null, metaJson]
    );
  } else {
    await dbRun(
      `INSERT INTO outreach_log (channel, target, target_kind, subject, body_excerpt, response, entity_id, metadata)
       VALUES (?,?,?,?,?,?,?,?)`,
      [channel, target, target_kind, subject || null, body_excerpt || null, response || null, entity_id || null, metaJson]
    );
  }
}

async function listOutreach({ limit = 200, channel = null } = {}) {
  const conds = ['1=1'];
  const params = [];
  if (channel) {
    conds.push(`channel = ${p(params.length + 1)}`);
    params.push(channel);
  }
  return dbAll(
    `SELECT id, ts, channel, target, target_kind, subject, response, entity_id
       FROM outreach_log
      WHERE ${conds.join(' AND ')}
      ORDER BY ts DESC
      LIMIT ${Number(limit)}`,
    params
  );
}

// ---------------------------------------------------------------------------
// Attribution keys
// ---------------------------------------------------------------------------
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

async function issueAttributionKey({ project_name, project_url, project_logo, contact_email, contact_wallet }) {
  const id = `attr_${crypto.randomBytes(6).toString('hex')}`;
  const plaintext = `atk_${crypto.randomBytes(24).toString('hex')}`;
  const key_hash = sha256(plaintext);
  const now = new Date().toISOString();
  if (isPg()) {
    await dbRun(
      `INSERT INTO attribution_keys
         (id, key_hash, project_name, project_url, project_logo, contact_email, contact_wallet, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, key_hash, project_name, project_url, project_logo || null, contact_email, contact_wallet || null, now]
    );
  } else {
    await dbRun(
      `INSERT INTO attribution_keys
         (id, key_hash, project_name, project_url, project_logo, contact_email, contact_wallet, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, key_hash, project_name, project_url, project_logo || null, contact_email, contact_wallet || null, now]
    );
  }
  return { id, key: plaintext }; // plaintext is only returned here, never stored
}

async function verifyAttributionKey(plaintext) {
  if (!plaintext || !plaintext.startsWith('atk_')) return null;
  const key_hash = sha256(plaintext);
  return dbGet(
    `SELECT id, project_name, project_url, project_logo, verified_at, revoked_at
       FROM attribution_keys WHERE key_hash = ${p(1)} AND revoked_at IS NULL`,
    [key_hash]
  );
}

async function markAttributionVerified(id) {
  const now = new Date().toISOString();
  await dbRun(
    `UPDATE attribution_keys SET verified_at = ${p(1)} WHERE id = ${p(2)} AND verified_at IS NULL`,
    [now, id]
  );
}

async function revokeAttributionKey(id) {
  const now = new Date().toISOString();
  await dbRun(
    `UPDATE attribution_keys SET revoked_at = ${p(1)} WHERE id = ${p(2)}`,
    [now, id]
  );
}

async function listAttributionKeys({ limit = 200, onlyVerified = false } = {}) {
  const conds = ['revoked_at IS NULL'];
  if (onlyVerified) conds.push('verified_at IS NOT NULL');
  return dbAll(
    `SELECT id, project_name, project_url, project_logo, contact_email, contact_wallet,
            created_at, verified_at
       FROM attribution_keys
      WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ${Number(limit)}`
  );
}

// ---------------------------------------------------------------------------
// GitHub snapshots
// ---------------------------------------------------------------------------
async function recordGithubSnapshot({ repo, stars, forks, watchers, open_issues, metadata }) {
  const metaJson = isPg() ? (metadata || {}) : JSON.stringify(metadata || {});
  if (isPg()) {
    await dbRun(
      `INSERT INTO github_snapshots (repo, stars, forks, watchers, open_issues, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [repo, stars, forks, watchers, open_issues, metaJson]
    );
  } else {
    await dbRun(
      `INSERT INTO github_snapshots (repo, stars, forks, watchers, open_issues, metadata)
       VALUES (?,?,?,?,?,?)`,
      [repo, stars, forks, watchers, open_issues, metaJson]
    );
  }
}

async function listGithubSnapshots({ repo = null, limit = 60 } = {}) {
  const conds = ['1=1'];
  const params = [];
  if (repo) {
    conds.push(`repo = ${p(params.length + 1)}`);
    params.push(repo);
  }
  return dbAll(
    `SELECT id, ts, repo, stars, forks, watchers, open_issues
       FROM github_snapshots
      WHERE ${conds.join(' AND ')}
      ORDER BY ts DESC LIMIT ${Number(limit)}`,
    params
  );
}

module.exports = {
  ensureSchema,
  HEAT_POINTS,
  heatFor,
  insertEvent,
  resolveAndUpsertEntity,
  listEntities,
  listEvents,
  recordOutreach,
  listOutreach,
  attribution: {
    issue: issueAttributionKey,
    verify: verifyAttributionKey,
    markVerified: markAttributionVerified,
    revoke: revokeAttributionKey,
    list: listAttributionKeys,
  },
  recordGithubSnapshot,
  listGithubSnapshots,
};
