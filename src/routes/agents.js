const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
const { generateWallet, isChainMode, getUsdcBalance } = require('../wallet');

const router = express.Router();

// SQLite uses ?, PostgreSQL uses $1 $2 ...
const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// POST /agents/register
router.post('/register', async (req, res, next) => {
  try {
    const { name, description, owner_email } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or less' });
    if (description && description.length > 1000) return res.status(400).json({ error: 'description must be 1000 characters or less' });

    const id = uuidv4();
    const api_key = uuidv4();

    // Generate Base chain wallet (chain mode) or skip (mock mode)
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

    // In chain mode, new agents start with 0 balance (must deposit real USDC)
    // In mock mode, start with 100 fake USDC for testing
    const initialBalance = isChainMode() ? 0 : 100.0;

    await dbRun(
      `INSERT INTO agents (id, name, description, api_key, owner_email, balance, wallet_address, wallet_encrypted_key)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)})`,
      [id, name, description || null, api_key, owner_email || null, initialBalance, wallet_address, wallet_encrypted_key]
    );

    res.status(201).json({
      id, name, description, owner_email, api_key,
      balance: initialBalance,
      wallet_address,
      chain: isChainMode() ? (process.env.CHAIN || 'base-sepolia') : null,
      message: isChainMode()
        ? `Agent registered. Deposit USDC to ${wallet_address} on ${process.env.CHAIN || 'Base Sepolia'} to fund your account.`
        : 'Agent registered. Save your api_key — it will not be shown again.'
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
    const [history, byCategory] = await Promise.all([
      dbAll(
        `SELECT delta, reason, order_id, created_at FROM reputation_history WHERE agent_id = ${p(1)} ORDER BY created_at DESC LIMIT 50`,
        [req.params.id]
      ),
      dbAll(
        `SELECT category, score, order_count FROM reputation_by_category WHERE agent_id = ${p(1)} ORDER BY score DESC`,
        [req.params.id]
      ).catch(() => []),
    ]);
    res.json({
      agent_id: agent.id,
      name: agent.name,
      reputation_score: parseInt(agent.reputation_score || 0),
      by_category: byCategory.map(r => ({
        category: r.category,
        score: parseInt(r.score || 0),
        order_count: parseInt(r.order_count || 0),
      })),
      history,
    });
  } catch (err) { next(err); }
});

// GET /agents/:id/services — list services owned by this agent
router.get('/:id/services', requireApiKey, async (req, res, next) => {
  try {
    if (req.agent.id !== req.params.id) return res.status(403).json({ error: 'Can only view your own services' });
    const services = await dbAll(
      `SELECT s.*, f.filename as file_name
       FROM services s
       LEFT JOIN files f ON s.file_id = f.id
       WHERE s.agent_id = ${p(1)}
       ORDER BY s.created_at DESC`,
      [req.agent.id]
    );
    res.json({ count: services.length, services });
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
      `SELECT id, name, description, owner_email, balance, escrow, COALESCE(stake, 0) as stake,
              COALESCE(reputation_score, 0) as reputation_score, wallet_address, created_at
       FROM agents WHERE id = ${p(1)}`,
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

// POST /agents/:id/rotate-key — generate a new API key (invalidates old one)
router.post('/:id/rotate-key', requireApiKey, async (req, res, next) => {
  try {
    if (req.agent.id !== req.params.id) return res.status(403).json({ error: 'Access denied' });
    const newKey = uuidv4();
    await dbRun(`UPDATE agents SET api_key = ${p(1)} WHERE id = ${p(2)}`, [newKey, req.agent.id]);
    res.json({ api_key: newKey, message: 'API key rotated. Update your stored key — old key is now invalid.' });
  } catch (err) { next(err); }
});

// POST /agents/:id/sync-balance — pull on-chain USDC balance and credit any new deposits
router.post('/:id/sync-balance', requireApiKey, async (req, res, next) => {
  try {
    if (req.agent.id !== req.params.id) return res.status(403).json({ error: 'Access denied' });
    if (!isChainMode()) return res.status(400).json({ error: 'Not in chain mode' });

    const agent = await dbGet(
      `SELECT balance, wallet_address, wallet_encrypted_key FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent?.wallet_address) return res.status(400).json({ error: 'No wallet on this agent' });

    const onChain = await getUsdcBalance(agent.wallet_address);
    const dbBalance = parseFloat(agent.balance || 0);

    if (onChain <= dbBalance) {
      return res.json({ synced: false, on_chain: onChain, db_balance: dbBalance, message: 'No new deposits detected' });
    }

    const diff = parseFloat((onChain - dbBalance).toFixed(6));
    const { v4: uuidv4 } = require('uuid');
    const depositId = uuidv4();
    const txRef = 'sync_' + Date.now();

    await dbRun(`UPDATE agents SET balance = ${p(1)} WHERE id = ${p(2)}`, [onChain, req.agent.id]);
    await dbRun(
      `INSERT INTO deposits (id, agent_id, amount, tx_hash) VALUES (${p(1)},${p(2)},${p(3)},${p(4)})`,
      [depositId, req.agent.id, diff, txRef]
    );

    res.json({ synced: true, credited: diff, new_balance: onChain, message: `Detected +${diff} USDC on-chain, balance updated.` });
  } catch (err) { next(err); }
});

// GET /agents/:id/wallet — wallet address + on-chain USDC balance
router.get('/:id/wallet', requireApiKey, async (req, res, next) => {
  try {
    if (req.agent.id !== req.params.id) return res.status(403).json({ error: 'Access denied' });
    const agent = await dbGet(`SELECT wallet_address, balance FROM agents WHERE id = ${p(1)}`, [req.params.id]);
    if (!agent?.wallet_address) {
      return res.json({ wallet_address: null, db_balance: parseFloat(agent?.balance || 0), chain_balance: null, mode: 'mock' });
    }
    let chain_balance = null;
    if (isChainMode()) {
      try { chain_balance = await getUsdcBalance(agent.wallet_address); } catch (e) {}
    }
    res.json({
      wallet_address: agent.wallet_address,
      db_balance: parseFloat(agent.balance || 0),
      chain_balance,
      chain: process.env.CHAIN || 'base-sepolia',
      mode: isChainMode() ? 'chain' : 'mock'
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

// GET /agents/:id/reputation-badge
// Returns JSON + SVG badge for cross-platform reputation display.
router.get('/:id/reputation-badge', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, COALESCE(reputation_score, 0) as score FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const score = parseInt(agent.score) || 0;
    const level = score >= 200 ? 'Elite' : score >= 100 ? 'Trusted' : score >= 50 ? 'Active' : 'New';
    const color = score >= 200 ? '#2563eb' : score >= 100 ? '#16a34a' : score >= 50 ? '#d97706' : '#6b7280';

    const format = req.query.format || 'json';

    if (format === 'svg') {
      const label = 'Arbitova';
      const value = `${level} · ${score}`;
      const labelWidth = 70;
      const valueWidth = Math.max(value.length * 7 + 16, 80);
      const totalWidth = labelWidth + valueWidth;

      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <rect rx="3" width="${totalWidth}" height="20" fill="#555"/>
  <rect rx="3" x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
  <rect rx="3" width="${totalWidth}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${value}</text>
  </g>
</svg>`);
    }

    res.json({
      agent_id: agent.id,
      name: agent.name,
      reputation_score: score,
      level,
      badge_url: `${process.env.API_BASE_URL || 'https://a2a-system.onrender.com'}/api/v1/agents/${agent.id}/reputation-badge?format=svg`,
      verified_by: 'arbitova',
    });
  } catch (err) { next(err); }
});

module.exports = router;
