'use strict';

const crypto = require('crypto');
const { dbGet, dbRun } = require('../db/helpers');
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

/**
 * requireAccountSession
 *
 * For account-facing endpoints called from the web UI. Verifies a Supabase
 * access token (sent as Bearer or supabase-access-token header) and resolves
 * it to a row in the accounts table. Auto-creates the account row on first
 * call so a freshly-signed-up user doesn't get a 404 before they have any
 * agents.
 *
 * Populates req.account = { id, email, display_name, supabase_user_id }.
 * Use this for /api/v1/accounts/me/* (human → account operations).
 * For machine-to-machine agent calls, keep using requireApiKey.
 */
async function requireAccountSession(req, res, next) {
  const bearer = req.headers.authorization || '';
  const token = bearer.startsWith('Bearer ')
    ? bearer.slice(7)
    : req.headers['supabase-access-token'];

  if (!token) {
    return res.status(401).json({ error: 'Missing session token', code: 'missing_session' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Session auth not configured', code: 'auth_not_configured' });
  }

  try {
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_SERVICE_KEY,
      },
    });
    if (!resp.ok) {
      return res.status(401).json({ error: 'Invalid or expired session', code: 'invalid_session' });
    }
    const supaUser = await resp.json();

    const isPostgres = db.type === 'pg';
    const p = (n) => isPostgres ? `$${n}` : '?';

    let account = await dbGet(
      `SELECT id, supabase_user_id, email, display_name FROM accounts WHERE supabase_user_id = ${p(1)}`,
      [supaUser.id]
    );

    if (!account && supaUser.email) {
      // Fall back to email match (handles legacy users whose accounts row
      // was backfilled before we had their supabase_user_id).
      account = await dbGet(
        `SELECT id, supabase_user_id, email, display_name FROM accounts WHERE email = ${p(1)}`,
        [supaUser.email]
      );
      if (account && !account.supabase_user_id?.startsWith('legacy_')) {
        account = null; // email collision with a different supabase user — don't hijack
      } else if (account) {
        await dbRun(
          `UPDATE accounts SET supabase_user_id = ${p(1)} WHERE id = ${p(2)}`,
          [supaUser.id, account.id]
        );
        account.supabase_user_id = supaUser.id;
      }
    }

    if (!account) {
      // Auto-provision: first visit after sign-up, no backfilled row exists yet.
      const accId = crypto.randomUUID();
      const displayName = supaUser.user_metadata?.full_name
        || supaUser.user_metadata?.name
        || supaUser.email?.split('@')[0]
        || 'Account';
      const provider = supaUser.app_metadata?.provider || 'email';
      await dbRun(
        `INSERT INTO accounts (id, supabase_user_id, email, display_name, auth_provider)
         VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`,
        [accId, supaUser.id, supaUser.email, displayName, provider]
      );
      account = {
        id: accId,
        supabase_user_id: supaUser.id,
        email: supaUser.email,
        display_name: displayName,
      };
    }

    // Link any agents created via legacy /auth/social (which only set
    // supabase_user_id but not account_id) into this account.
    await dbRun(
      `UPDATE agents SET account_id = ${p(1)}
       WHERE supabase_user_id = ${p(2)} AND account_id IS NULL`,
      [account.id, supaUser.id]
    ).catch(() => { /* column missing on very old DBs */ });

    req.account = account;
    next();
  } catch (err) { next(err); }
}

module.exports = { requireApiKey, requireAccountSession };
