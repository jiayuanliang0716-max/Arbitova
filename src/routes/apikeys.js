'use strict';

/**
 * apikeys.js — Multiple API key management per agent
 *
 * Developers can create multiple keys with different scopes:
 *   full        — all read + write operations
 *   read        — GET endpoints only
 *   transactions — orders + deliveries only (no account management)
 *
 * Keys are stored as SHA-256 hashes. The plaintext key is returned once on creation.
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const VALID_SCOPES = ['full', 'read', 'transactions'];

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateKey() {
  // Format: arb_<32 random hex chars>
  return 'arb_' + crypto.randomBytes(16).toString('hex');
}

// ── POST /api/v1/api-keys ─────────────────────────────────────────────────────
// Create a new API key. Returns plaintext key once — save it.
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { name, scope = 'full' } = req.body;

    if (!VALID_SCOPES.includes(scope)) {
      return res.status(400).json({
        error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}`,
        code: 'invalid_scope',
      });
    }

    // Limit: max 10 active keys per agent
    const existing = await dbAll(
      `SELECT id FROM api_keys WHERE agent_id = ${p(1)} AND is_active = ${isPostgres ? 'true' : '1'}`,
      [req.agent.id]
    );
    if (existing.length >= 10) {
      return res.status(400).json({
        error: 'Maximum 10 active API keys per agent.',
        code: 'key_limit_exceeded',
      });
    }

    const id = uuidv4();
    const key = generateKey();
    const keyHash = hashKey(key);
    const keyPrefix = key.slice(0, 12); // "arb_" + 8 chars

    await dbRun(
      `INSERT INTO api_keys (id, agent_id, key_hash, key_prefix, name, scope)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
      [id, req.agent.id, keyHash, keyPrefix, name || null, scope]
    );

    res.status(201).json({
      id,
      key,        // shown only once — developer must save this
      key_prefix: keyPrefix + '...',
      name:       name || null,
      scope,
      is_active:  true,
      created_at: new Date().toISOString(),
      _note: 'Save this key — it will not be shown again.',
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/api-keys ──────────────────────────────────────────────────────
// List all API keys (masked — no plaintext).
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT id, key_prefix, name, scope, is_active, last_used_at, created_at
       FROM api_keys WHERE agent_id = ${p(1)} ORDER BY created_at DESC`,
      [req.agent.id]
    );

    const keys = rows.map(k => ({
      ...k,
      key_prefix: k.key_prefix + '...',
      is_active: !!k.is_active,
    }));

    res.json({ api_keys: keys, count: keys.length });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/api-keys/:id ───────────────────────────────────────────────
// Revoke (deactivate) an API key.
router.delete('/:id', requireApiKey, async (req, res, next) => {
  try {
    const key = await dbGet(
      `SELECT id FROM api_keys WHERE id = ${p(1)} AND agent_id = ${p(2)}`,
      [req.params.id, req.agent.id]
    );

    if (!key) return res.status(404).json({ error: 'API key not found', code: 'not_found' });

    await dbRun(
      `UPDATE api_keys SET is_active = ${isPostgres ? 'false' : '0'} WHERE id = ${p(1)}`,
      [req.params.id]
    );

    res.status(204).send();
  } catch (err) { next(err); }
});

module.exports = router;
