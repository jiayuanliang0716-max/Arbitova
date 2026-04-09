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

// GET /agents/leaderboard — public, top agents by reputation
router.get('/leaderboard', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const agents = await dbAll(
      `SELECT a.id, a.name, a.description, COALESCE(a.reputation_score, 0) as reputation_score,
              (SELECT COUNT(*) FROM orders WHERE seller_id = a.id AND status = 'completed') as completed_sales
       FROM agents a
       ORDER BY COALESCE(a.reputation_score, 0) DESC, a.created_at ASC
       LIMIT ${p(1)}`,
      [limit]
    );
    res.json({ count: agents.length, agents: agents.map(a => ({
      ...a,
      reputation_score: parseInt(a.reputation_score || 0),
      completed_sales: parseInt(a.completed_sales || 0)
    })) });
  } catch (err) { next(err); }
});

// GET /agents/:id/reputation — public, score + history
router.get('/:id/reputation', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, COALESCE(reputation_score, 0) as reputation_score FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const history = await dbAll(
      `SELECT delta, reason, order_id, created_at FROM reputation_history WHERE agent_id = ${p(1)} ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({
      agent_id: agent.id,
      name: agent.name,
      reputation_score: parseInt(agent.reputation_score || 0),
      history
    });
  } catch (err) { next(err); }
});

// GET /agents/:id/orders — auth required, buyer or seller
router.get('/:id/orders', requireApiKey, async (req, res, next) => {
  try {
    if (req.agent.id !== req.params.id) {
      return res.status(403).json({ error: 'Can only view your own orders' });
    }
    const orders = await dbAll(
      `SELECT o.*, s.name as service_name
       FROM orders o
       JOIN services s ON o.service_id = s.id
       WHERE o.buyer_id = ${p(1)} OR o.seller_id = ${p(2)}
       ORDER BY o.created_at DESC
       LIMIT 100`,
      [req.params.id, req.params.id]
    );
    res.json({ count: orders.length, orders });
  } catch (err) { next(err); }
});

// GET /agents/:id
router.get('/:id', requireApiKey, async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, description, owner_email, balance, escrow, COALESCE(stake, 0) as stake, COALESCE(reputation_score, 0) as reputation_score, created_at FROM agents WHERE id = ${p(1)}`,
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

// POST /agents/stake — lock balance as stake (trust bond)
router.post('/stake', requireApiKey, async (req, res, next) => {
  try {
    const { amount } = req.body;
    const n = parseFloat(amount);
    if (!(n > 0)) return res.status(400).json({ error: 'amount must be positive' });
    const agent = await dbGet(`SELECT balance, stake FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(agent.balance) < n) {
      return res.status(400).json({ error: 'Insufficient balance', balance: agent.balance });
    }
    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)}, stake = COALESCE(stake, 0) + ${p(2)} WHERE id = ${p(3)}`,
      [n, n, req.agent.id]
    );
    const updated = await dbGet(`SELECT balance, stake FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    res.json({ message: `Staked ${n} USDC`, balance: updated.balance, stake: updated.stake });
  } catch (err) { next(err); }
});

// POST /agents/unstake — release stake back to balance
router.post('/unstake', requireApiKey, async (req, res, next) => {
  try {
    const { amount } = req.body;
    const n = parseFloat(amount);
    if (!(n > 0)) return res.status(400).json({ error: 'amount must be positive' });
    const agent = await dbGet(`SELECT balance, stake FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(agent.stake || 0) < n) {
      return res.status(400).json({ error: 'Insufficient stake', stake: agent.stake || 0 });
    }
    await dbRun(
      `UPDATE agents SET balance = balance + ${p(1)}, stake = stake - ${p(2)} WHERE id = ${p(3)}`,
      [n, n, req.agent.id]
    );
    const updated = await dbGet(`SELECT balance, stake FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    res.json({ message: `Unstaked ${n} USDC`, balance: updated.balance, stake: updated.stake });
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
