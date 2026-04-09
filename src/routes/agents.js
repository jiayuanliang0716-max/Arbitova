const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

// SQLite uses ?, PostgreSQL uses $1 $2 ...
const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// POST /agents/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, description, owner_email } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const id = uuidv4();
    const api_key = uuidv4();

    await dbRun(
      `INSERT INTO agents (id, name, description, api_key, owner_email) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
      [id, name, description || null, api_key, owner_email || null]
    );

    res.status(201).json({
      id, name, description, owner_email, api_key,
      balance: 100.0,
      message: 'Agent registered. Save your api_key — it will not be shown again.'
    });
  } catch (err) { next(err); }
});

// GET /agents/:id
router.get('/:id', requireApiKey, async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, description, owner_email, balance, escrow, created_at FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const completed_sales = await dbGet(
      `SELECT COUNT(*) as c FROM orders WHERE seller_id = ${p(1)} AND status = 'completed'`,
      [req.params.id]
    );
    const completed_purchases = await dbGet(
      `SELECT COUNT(*) as c FROM orders WHERE buyer_id = ${p(1)} AND status = 'completed'`,
      [req.params.id]
    );

    res.json({
      ...agent,
      completed_sales: parseInt(completed_sales?.c || 0),
      completed_purchases: parseInt(completed_purchases?.c || 0)
    });
  } catch (err) { next(err); }
});

// POST /agents/topup
router.post('/topup', requireApiKey, async (req, res, next) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });

    await dbRun(
      `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
      [amount, req.agent.id]
    );
    const updated = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);

    res.json({ message: `Topped up ${amount} USDC`, new_balance: updated.balance });
  } catch (err) { next(err); }
});

module.exports = router;
