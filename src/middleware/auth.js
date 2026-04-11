'use strict';

const crypto = require('crypto');
const { dbGet } = require('../db/helpers');
const db = require('../db/schema');

// Read-only HTTP methods
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Endpoints allowed under 'transactions' scope
const TRANSACTIONS_PATHS = [
  '/orders', '/deliveries', '/disputes',
];

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function scopeAllowed(scope, req) {
  if (scope === 'full') return true;
  if (scope === 'read') return READ_METHODS.has(req.method);
  if (scope === 'transactions') {
    const path = req.path.toLowerCase();
    return TRANSACTIONS_PATHS.some(prefix => path.startsWith(prefix));
  }
  return false;
}

async function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing X-API-Key header',
      code: 'missing_api_key',
    });
  }

  try {
    const isPostgres = db.type === 'pg';
    const p = (n) => isPostgres ? `$${n}` : '?';

    // 1. Check new api_keys table first (hashed lookup)
    const keyHash = hashKey(apiKey);
    const apiKeyRow = await dbGet(
      `SELECT ak.id, ak.scope, ak.is_active, ak.agent_id
       FROM api_keys ak
       WHERE ak.key_hash = ${p(1)}`,
      [keyHash]
    ).catch(() => null); // table may not exist yet on old DBs

    let agent = null;
    let scope = 'full';

    if (apiKeyRow) {
      const active = isPostgres ? apiKeyRow.is_active : !!apiKeyRow.is_active;
      if (!active) {
        return res.status(401).json({ error: 'API key has been revoked', code: 'key_revoked' });
      }
      scope = apiKeyRow.scope || 'full';
      agent = await dbGet(
        `SELECT id, name, balance, escrow, stake, reputation_score, wallet_address
         FROM agents WHERE id = ${p(1)}`,
        [apiKeyRow.agent_id]
      );
      // Update last_used_at asynchronously
      dbGet(
        `UPDATE api_keys SET last_used_at = ${isPostgres ? 'NOW()' : "datetime('now')"} WHERE id = ${p(1)}`,
        [apiKeyRow.id]
      ).catch(() => {});
    } else {
      // 2. Fall back to legacy agents.api_key (scope = full)
      const sql = isPostgres
        ? 'SELECT id, name, balance, escrow, stake, reputation_score, wallet_address FROM agents WHERE api_key = $1'
        : 'SELECT id, name, balance, escrow, stake, reputation_score, wallet_address FROM agents WHERE api_key = ?';
      agent = await dbGet(sql, [apiKey]);
      scope = 'full';
    }

    if (!agent) {
      return res.status(401).json({ error: 'Invalid API key', code: 'invalid_api_key' });
    }

    // Enforce scope
    if (!scopeAllowed(scope, req)) {
      return res.status(403).json({
        error: `API key scope '${scope}' does not allow ${req.method} on this endpoint`,
        code: 'insufficient_scope',
        required_scope: 'full',
        your_scope: scope,
      });
    }

    req.agent = agent;
    req.apiKeyScope = scope;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireApiKey };
