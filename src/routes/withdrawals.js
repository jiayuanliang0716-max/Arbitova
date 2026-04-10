const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
const { transferUsdc, isChainMode } = require('../wallet');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const MIN_WITHDRAWAL = 1; // minimum 1 USDC

// POST /withdrawals — request withdrawal to external address
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { to_address, amount } = req.body || {};
    if (!to_address) return res.status(400).json({ error: 'to_address is required' });
    const n = parseFloat(amount);
    if (!(n >= MIN_WITHDRAWAL)) return res.status(400).json({ error: `Minimum withdrawal is ${MIN_WITHDRAWAL} USDC` });

    // Validate address format
    if (!/^0x[0-9a-fA-F]{40}$/.test(to_address)) {
      return res.status(400).json({ error: 'Invalid Ethereum address format' });
    }

    const agent = await dbGet(
      `SELECT balance, wallet_address, wallet_encrypted_key FROM agents WHERE id = ${p(1)}`,
      [req.agent.id]
    );
    if (parseFloat(agent.balance) < n) {
      return res.status(400).json({ error: 'Insufficient balance', balance: agent.balance, requested: n });
    }

    const withdrawalId = uuidv4();

    if (!isChainMode()) {
      // Mock mode: instant withdrawal (no real transfer)
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [n, req.agent.id]);
      await dbRun(
        `INSERT INTO withdrawals (id, agent_id, amount, to_address, tx_hash, status, completed_at)
         VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},'completed',${now})`,
        [withdrawalId, req.agent.id, n, to_address, 'mock_tx_' + withdrawalId.slice(0, 8)]
      );
      return res.json({
        id: withdrawalId,
        amount: n,
        to_address,
        status: 'completed',
        tx_hash: 'mock_tx_' + withdrawalId.slice(0, 8),
        mode: 'mock',
        message: 'Mock withdrawal completed (no real transfer in mock mode)'
      });
    }

    // Chain mode: execute real USDC transfer
    if (!agent.wallet_encrypted_key) {
      return res.status(400).json({ error: 'Agent has no wallet. Re-register to get a wallet.' });
    }

    // Lock balance first
    await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [n, req.agent.id]);
    await dbRun(
      `INSERT INTO withdrawals (id, agent_id, amount, to_address, status) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'pending')`,
      [withdrawalId, req.agent.id, n, to_address]
    );

    try {
      const result = await transferUsdc(agent.wallet_encrypted_key, to_address, n);
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(
        `UPDATE withdrawals SET tx_hash = ${p(1)}, status = 'completed', completed_at = ${now} WHERE id = ${p(2)}`,
        [result.txHash, withdrawalId]
      );
      res.json({
        id: withdrawalId,
        amount: n,
        to_address,
        tx_hash: result.txHash,
        block: result.blockNumber,
        status: 'completed',
        chain: process.env.CHAIN || 'base-sepolia',
        message: 'Withdrawal sent on-chain.'
      });
    } catch (chainErr) {
      // Rollback balance on failure
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [n, req.agent.id]);
      await dbRun(`UPDATE withdrawals SET status = 'failed' WHERE id = ${p(1)}`, [withdrawalId]);
      return res.status(500).json({ error: 'On-chain transfer failed', details: chainErr.message });
    }
  } catch (err) { next(err); }
});

// GET /withdrawals — list my withdrawal history
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT * FROM withdrawals WHERE agent_id = ${p(1)} ORDER BY created_at DESC LIMIT 50`,
      [req.agent.id]
    );
    res.json({ count: rows.length, withdrawals: rows });
  } catch (err) { next(err); }
});

// GET /deposits — list my deposit history
router.get('/deposits', requireApiKey, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT * FROM deposits WHERE agent_id = ${p(1)} ORDER BY confirmed_at DESC LIMIT 50`,
      [req.agent.id]
    );
    res.json({ count: rows.length, deposits: rows });
  } catch (err) { next(err); }
});

module.exports = router;
