'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('../db/helpers');
const { generateWallet, isChainMode } = require('../wallet');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

/**
 * POST /api/v1/auth/social
 *
 * Accepts a Supabase access_token from social login (Google, Apple, GitHub).
 * Verifies the token with Supabase, then either:
 *   - Returns existing agent linked to this Supabase user
 *   - Auto-creates a new agent and links it
 *
 * Body: { access_token: string }
 * Returns: { id, name, api_key, is_new }
 */
router.post('/social', async (req, res, next) => {
  try {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: 'access_token is required', code: 'missing_token' });
    }

    // Verify token with Supabase Auth API
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(503).json({ error: 'Social auth not configured', code: 'auth_not_configured' });
    }

    // Get user info from Supabase using the access token
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'apikey': SUPABASE_SERVICE_KEY,
      },
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid or expired token', code: 'invalid_token' });
    }

    const supaUser = await userResp.json();
    const supabaseUserId = supaUser.id;
    const email = supaUser.email;
    const provider = supaUser.app_metadata?.provider || 'unknown';
    const displayName = supaUser.user_metadata?.full_name
      || supaUser.user_metadata?.name
      || email?.split('@')[0]
      || 'Agent';

    // Check if an agent is already linked to this Supabase user
    let agent = await dbGet(
      `SELECT id, name, api_key FROM agents WHERE supabase_user_id = ${p(1)}`,
      [supabaseUserId]
    ).catch(() => null);

    if (agent) {
      // Existing user — return their credentials
      return res.json({
        id: agent.id,
        name: agent.name,
        api_key: agent.api_key,
        is_new: false,
        provider,
      });
    }

    // Also check by email in case they registered before social login was added
    if (email) {
      agent = await dbGet(
        `SELECT id, name, api_key, supabase_user_id FROM agents WHERE owner_email = ${p(1)}`,
        [email]
      ).catch(() => null);

      if (agent && !agent.supabase_user_id) {
        // Link existing agent to Supabase user
        await dbRun(
          `UPDATE agents SET supabase_user_id = ${p(1)}, auth_provider = ${p(2)} WHERE id = ${p(3)}`,
          [supabaseUserId, provider, agent.id]
        );
        return res.json({
          id: agent.id,
          name: agent.name,
          api_key: agent.api_key,
          is_new: false,
          provider,
          linked: true,
        });
      }
    }

    // New user — auto-create agent
    const id = uuidv4();
    const api_key = uuidv4();

    let wallet_address = null;
    let wallet_encrypted_key = null;
    if (isChainMode()) {
      try {
        const w = generateWallet();
        wallet_address = w.address;
        wallet_encrypted_key = w.encryptedKey;
      } catch (e) {
        console.error('Wallet generation failed:', e.message);
      }
    }

    const initialBalance = isChainMode() ? 0 : 100.0;

    await dbRun(
      `INSERT INTO agents (id, name, api_key, owner_email, balance, wallet_address, wallet_encrypted_key, supabase_user_id, auth_provider)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)})`,
      [id, displayName, api_key, email, initialBalance, wallet_address, wallet_encrypted_key, supabaseUserId, provider]
    );

    res.status(201).json({
      id,
      name: displayName,
      api_key,
      balance: initialBalance,
      wallet_address,
      is_new: true,
      provider,
    });
  } catch (err) { next(err); }
});

module.exports = router;
