/**
 * webhook.js — Alchemy Address Activity webhook handler
 *
 * Detects incoming USDC to any agent wallet and credits their DB balance.
 *
 * Setup in Alchemy Dashboard:
 *   Notify → Address Activity → add all agent wallet addresses
 *   Webhook URL: https://a2a-system.onrender.com/webhook/alchemy
 *   Signing key: set ALCHEMY_WEBHOOK_SIGNING_KEY env var
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('./db/helpers');
const { USDC_ADDRESS } = require('./wallet');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const USDC_DECIMALS = 6;

function verifyAlchemySignature(rawBody, signature) {
  const signingKey = process.env.ALCHEMY_WEBHOOK_SIGNING_KEY;
  if (!signingKey) return true; // skip verification if key not set (dev mode)
  const hmac = crypto.createHmac('sha256', signingKey);
  hmac.update(rawBody, 'utf8');
  const expected = hmac.digest('hex');
  return signature === expected;
}

// POST /webhook/alchemy
router.post('/alchemy', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const sig = req.headers['x-alchemy-signature'] || '';
    if (!verifyAlchemySignature(req.body, sig)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(req.body.toString());
    const activities = payload?.event?.activity || [];

    for (const act of activities) {
      // Only process incoming ERC-20 USDC transfers
      if (act.category !== 'token') continue;
      if ((act.rawContract?.address || '').toLowerCase() !== USDC_ADDRESS.toLowerCase()) continue;
      if (act.asset !== 'USDC') continue;

      const toAddress = act.toAddress?.toLowerCase();
      const fromAddress = act.fromAddress?.toLowerCase();
      const txHash = act.hash;
      const amount = parseFloat(act.value || 0);

      if (!toAddress || !txHash || !(amount > 0)) continue;

      // Find agent with this wallet address
      const agent = await dbGet(
        `SELECT id FROM agents WHERE LOWER(wallet_address) = ${p(1)}`,
        [toAddress]
      );
      if (!agent) continue;

      // Prevent duplicate processing
      const existing = await dbGet(`SELECT id FROM deposits WHERE tx_hash = ${p(1)}`, [txHash]);
      if (existing) continue;

      // Credit balance + record deposit
      const depositId = uuidv4();
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [amount, agent.id]);
      await dbRun(
        `INSERT INTO deposits (id, agent_id, amount, tx_hash, from_address) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
        [depositId, agent.id, amount, txHash, fromAddress]
      );

      console.log(`Deposit: ${amount} USDC → agent ${agent.id} (tx: ${txHash})`);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
