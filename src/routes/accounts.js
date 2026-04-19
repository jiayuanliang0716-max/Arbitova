'use strict';

/**
 * /api/v1/accounts/me/*  — account-facing endpoints (human, session-auth)
 *
 * These mirror the legacy /agents/me routes but operate on the accounts
 * concept added in the account/agent split refactor. One account can own
 * multiple agents; each agent has its own wallet and API keys.
 *
 * All routes require a Supabase JWT (see requireAccountSession middleware).
 */

const express = require('express');
const crypto = require('crypto');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const db = require('../db/schema');
const { requireAccountSession } = require('../middleware/auth');
const { generateWallet, isChainMode } = require('../wallet');

const router = express.Router();

const isPostgres = () => db.type === 'pg';
const p = (n) => isPostgres() ? `$${n}` : '?';

router.use(requireAccountSession);

// ── GET /me ───────────────────────────────────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const agents = await dbAll(
      `SELECT id, name, status, reputation_score
       FROM agents WHERE account_id = ${p(1)}`,
      [req.account.id]
    );
    res.json({ ...req.account, agent_count: agents.length });
  } catch (err) { next(err); }
});

// ── GET /me/agents ────────────────────────────────────────────────────────
router.get('/me/agents', async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT a.id, a.name, a.description, a.status, a.reputation_score,
              a.created_at,
              COALESCE(w.balance, 0)  AS balance,
              COALESCE(w.escrow, 0)   AS escrow,
              w.address               AS wallet_address
       FROM agents a
       LEFT JOIN wallets w ON w.agent_id = a.id AND w.currency = 'USD'
       WHERE a.account_id = ${p(1)}
       ORDER BY a.created_at ASC`,
      [req.account.id]
    );
    res.json({ agents: rows });
  } catch (err) { next(err); }
});

// ── POST /me/agents — create a new agent under this account ───────────────
router.post('/me/agents', async (req, res, next) => {
  try {
    const { name, description } = req.body || {};
    if (!name || typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'name is required (1-100 chars)', code: 'invalid_name' });
    }

    const existing = await dbGet(
      `SELECT id FROM agents WHERE account_id = ${p(1)} AND name = ${p(2)}`,
      [req.account.id, name]
    );
    if (existing) {
      return res.status(409).json({ error: 'An agent with this name already exists', code: 'duplicate_name' });
    }

    const agentId = crypto.randomUUID();
    const rawKey = `ak_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 10);

    let walletAddress = null;
    let walletEncrypted = null;
    if (isChainMode()) {
      try {
        const w = generateWallet();
        walletAddress = w.address;
        walletEncrypted = w.encryptedKey;
      } catch (e) { /* non-fatal */ }
    }
    const initialBalance = isChainMode() ? 0 : 100.0;

    await dbRun(
      `INSERT INTO agents (id, account_id, name, description, api_key, owner_email,
                           balance, wallet_address, wallet_encrypted_key, status)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},'active')`,
      [agentId, req.account.id, name, description || null, rawKey, req.account.email,
       initialBalance, walletAddress, walletEncrypted]
    );

    await dbRun(
      `INSERT INTO wallets (id, agent_id, currency, balance, escrow, address, encrypted_key)
       VALUES (${p(1)},${p(2)},'USD',${p(3)},0,${p(4)},${p(5)})`,
      [crypto.randomUUID(), agentId, initialBalance, walletAddress, walletEncrypted]
    );

    const apiKeyId = crypto.randomUUID();
    await dbRun(
      `INSERT INTO api_keys (id, agent_id, key_hash, key_prefix, label, scope)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'default','full')`,
      [apiKeyId, agentId, keyHash, keyPrefix]
    );

    res.status(201).json({
      id: agentId,
      name,
      description: description || null,
      status: 'active',
      balance: initialBalance,
      wallet_address: walletAddress,
      api_key: rawKey, // shown ONCE — client must store it
      key_prefix: keyPrefix,
    });
  } catch (err) { next(err); }
});

// ── GET /me/agents/:id ────────────────────────────────────────────────────
router.get('/me/agents/:id', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT a.*, COALESCE(w.balance, 0) AS balance,
              COALESCE(w.escrow, 0) AS escrow, w.address AS wallet_address
       FROM agents a
       LEFT JOIN wallets w ON w.agent_id = a.id AND w.currency = 'USD'
       WHERE a.id = ${p(1)} AND a.account_id = ${p(2)}`,
      [req.params.id, req.account.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'not_found' });
    delete agent.api_key;
    delete agent.wallet_encrypted_key;
    res.json(agent);
  } catch (err) { next(err); }
});

// ── POST /me/agents/:id/keys — rotate / add new API key ───────────────────
router.post('/me/agents/:id/keys', async (req, res, next) => {
  try {
    const owned = await dbGet(
      `SELECT id FROM agents WHERE id = ${p(1)} AND account_id = ${p(2)}`,
      [req.params.id, req.account.id]
    );
    if (!owned) return res.status(404).json({ error: 'Agent not found', code: 'not_found' });

    const label = (req.body?.label || 'default').slice(0, 40);
    const rawKey = `ak_${crypto.randomBytes(24).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.slice(0, 10);
    const keyId = crypto.randomUUID();

    await dbRun(
      `INSERT INTO api_keys (id, agent_id, key_hash, key_prefix, label, scope)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},'full')`,
      [keyId, req.params.id, keyHash, keyPrefix, label]
    );

    res.status(201).json({
      id: keyId,
      key: rawKey, // shown ONCE
      key_prefix: keyPrefix,
      label,
    });
  } catch (err) { next(err); }
});

// ── GET /me/agents/:id/keys — list keys (no secrets) ──────────────────────
router.get('/me/agents/:id/keys', async (req, res, next) => {
  try {
    const owned = await dbGet(
      `SELECT id FROM agents WHERE id = ${p(1)} AND account_id = ${p(2)}`,
      [req.params.id, req.account.id]
    );
    if (!owned) return res.status(404).json({ error: 'Agent not found', code: 'not_found' });

    const rows = await dbAll(
      `SELECT id, key_prefix, label, scope, is_active, last_used_at, revoked_at, created_at
       FROM api_keys WHERE agent_id = ${p(1)} ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json({ keys: rows });
  } catch (err) { next(err); }
});

// ── DELETE /me/agents/:id/keys/:keyId — revoke ────────────────────────────
router.delete('/me/agents/:id/keys/:keyId', async (req, res, next) => {
  try {
    const owned = await dbGet(
      `SELECT id FROM agents WHERE id = ${p(1)} AND account_id = ${p(2)}`,
      [req.params.id, req.account.id]
    );
    if (!owned) return res.status(404).json({ error: 'Agent not found', code: 'not_found' });

    const now = isPostgres() ? 'NOW()' : "datetime('now')";
    await dbRun(
      `UPDATE api_keys SET revoked_at = ${now}, is_active = ${isPostgres() ? 'FALSE' : '0'}
       WHERE id = ${p(1)} AND agent_id = ${p(2)}`,
      [req.params.keyId, req.params.id]
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
