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

// GET /agents/me — authenticated agent's own profile
router.get('/me', requireApiKey, async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, description, owner_email, balance, escrow, COALESCE(stake, 0) as stake,
              COALESCE(reputation_score, 0) as reputation_score, wallet_address, created_at
       FROM agents WHERE id = ${p(1)}`,
      [req.agent.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const [completed_sales, completed_purchases, active_orders] = await Promise.all([
      dbGet(`SELECT COUNT(*) as c FROM orders WHERE seller_id = ${p(1)} AND status = 'completed'`, [req.agent.id]),
      dbGet(`SELECT COUNT(*) as c FROM orders WHERE buyer_id = ${p(1)} AND status = 'completed'`, [req.agent.id]),
      dbGet(`SELECT COUNT(*) as c FROM orders WHERE (buyer_id = ${p(1)} OR seller_id = ${p(2)}) AND status NOT IN ('completed','refunded','cancelled')`, [req.agent.id, req.agent.id]),
    ]);

    res.json({
      ...agent,
      reputation_score: parseInt(agent.reputation_score || 0),
      completed_sales: parseInt(completed_sales?.c || 0),
      completed_purchases: parseInt(completed_purchases?.c || 0),
      active_orders: parseInt(active_orders?.c || 0),
    });
  } catch (err) { next(err); }
});

// PATCH /agents/me — update own profile (name, description)
router.patch('/me', requireApiKey, async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name && !description) return res.status(400).json({ error: 'Provide at least name or description to update' });
    if (name && name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or less' });
    if (description && description.length > 1000) return res.status(400).json({ error: 'description must be 1000 characters or less' });

    if (isPostgres) {
      await dbRun(
        `UPDATE agents SET name=COALESCE($1,name), description=COALESCE($2,description) WHERE id=$3`,
        [name || null, description || null, req.agent.id]
      );
    } else {
      await dbRun(
        `UPDATE agents SET name=COALESCE(?,name), description=COALESCE(?,description) WHERE id=?`,
        [name || null, description || null, req.agent.id]
      );
    }
    const updated = await dbGet(
      `SELECT id, name, description, COALESCE(reputation_score, 0) as reputation_score, created_at FROM agents WHERE id = ${p(1)}`,
      [req.agent.id]
    );
    res.json({ ...updated, message: 'Profile updated' });
  } catch (err) { next(err); }
});

// GET /agents/me/summary — single-call bootstrap: profile + order stats + recent notifications
router.get('/me/summary', requireApiKey, async (req, res, next) => {
  try {
    const agentId = req.agent.id;

    const [agent, orderStats, pendingOrders, recentActivity] = await Promise.all([
      dbGet(`SELECT id, name, description, COALESCE(balance,0) as balance, COALESCE(escrow,0) as escrow, COALESCE(reputation_score,0) as reputation_score, wallet_address, created_at FROM agents WHERE id = ${p(1)}`, [agentId]),
      dbGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='disputed' THEN 1 ELSE 0 END) as disputed,
                SUM(CASE WHEN status='paid' AND seller_id=${p(2)} THEN 1 ELSE 0 END) as pending_delivery,
                SUM(CASE WHEN status='delivered' AND buyer_id=${p(3)} THEN 1 ELSE 0 END) as pending_confirmation
         FROM orders WHERE buyer_id=${p(4)} OR seller_id=${p(5)}`,
        [agentId, agentId, agentId, agentId, agentId]
      ),
      dbAll(
        `SELECT o.id, o.status, o.amount, o.created_at, s.name as service_name,
                CASE WHEN o.buyer_id=${p(2)} THEN 'buyer' ELSE 'seller' END as role
         FROM orders o LEFT JOIN services s ON o.service_id=s.id
         WHERE (o.buyer_id=${p(3)} OR o.seller_id=${p(4)}) AND o.status IN ('paid','delivered','disputed')
         ORDER BY o.created_at DESC LIMIT 5`,
        [agentId, agentId, agentId, agentId]
      ),
      dbAll(
        `SELECT delta, reason, created_at FROM reputation_history WHERE agent_id=${p(1)} ORDER BY created_at DESC LIMIT 5`,
        [agentId]
      ).catch(() => []),
    ]);

    const stats = orderStats || {};
    res.json({
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        balance: parseFloat(parseFloat(agent.balance).toFixed(6)),
        escrow: parseFloat(parseFloat(agent.escrow).toFixed(6)),
        reputation_score: parseInt(agent.reputation_score),
        wallet_address: agent.wallet_address,
        member_since: agent.created_at,
      },
      order_stats: {
        total: parseInt(stats.total || 0),
        completed: parseInt(stats.completed || 0),
        disputed: parseInt(stats.disputed || 0),
        pending_delivery: parseInt(stats.pending_delivery || 0),
        pending_confirmation: parseInt(stats.pending_confirmation || 0),
      },
      active_orders: pendingOrders.map(o => ({
        id: o.id, status: o.status, amount: parseFloat(o.amount),
        service: o.service_name, role: o.role, created_at: o.created_at,
      })),
      recent_reputation: recentActivity.map(r => ({ delta: r.delta, reason: r.reason, ts: r.created_at })),
    });
  } catch (err) { next(err); }
});

// GET /agents/me/services — authenticated agent's own services (all, including inactive)
router.get('/me/services', requireApiKey, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const services = await dbAll(
      `SELECT id, name, description, price, category, delivery_hours, is_active, auto_verify, created_at,
              (SELECT COUNT(*) FROM orders WHERE service_id = services.id AND status NOT IN ('cancelled','refunded')) as total_orders,
              (SELECT COUNT(*) FROM orders WHERE service_id = services.id AND status = 'completed') as completed_orders
       FROM services WHERE agent_id = ${p(1)}
       ORDER BY is_active DESC, created_at DESC LIMIT ${p(2)}`,
      [req.agent.id, limit]
    );
    res.json({ count: services.length, services: services.map(s => ({
      ...s,
      is_active: !!s.is_active,
      total_orders: parseInt(s.total_orders || 0),
      completed_orders: parseInt(s.completed_orders || 0),
    })) });
  } catch (err) { next(err); }
});

// GET /agents/me/escrow-breakdown — list all currently locked escrow orders with amounts and deadlines
router.get('/me/escrow-breakdown', requireApiKey, async (req, res, next) => {
  try {
    const agentId = req.agent.id;

    const [agent, orders] = await Promise.all([
      dbGet(`SELECT balance, COALESCE(escrow, 0) as escrow FROM agents WHERE id = ${p(1)}`, [agentId]),
      dbAll(
        `SELECT o.id, o.amount, o.status, o.deadline, o.created_at,
                s.name as service_name, s.category,
                a_buyer.name as buyer_name, a_seller.name as seller_name,
                CASE WHEN o.buyer_id = ${p(2)} THEN 'buyer' ELSE 'seller' END as role
         FROM orders o
         LEFT JOIN services s ON o.service_id = s.id
         LEFT JOIN agents a_buyer ON a_buyer.id = o.buyer_id
         LEFT JOIN agents a_seller ON a_seller.id = o.seller_id
         WHERE o.status IN ('paid', 'delivered') AND (o.buyer_id = ${p(3)} OR o.seller_id = ${p(4)})
         ORDER BY o.deadline ASC`,
        [agentId, agentId, agentId, agentId]
      ),
    ]);

    const now = new Date();
    const breakdown = orders.map(o => {
      const deadline = new Date(o.deadline);
      const hoursRemaining = Math.round((deadline - now) / 3600000);
      return {
        order_id: o.id,
        role: o.role,
        amount: parseFloat(o.amount),
        status: o.status,
        service: o.service_name || 'Unknown',
        category: o.category,
        counterparty: o.role === 'buyer' ? o.seller_name : o.buyer_name,
        deadline: o.deadline,
        hours_remaining: hoursRemaining,
        overdue: hoursRemaining < 0,
        created_at: o.created_at,
      };
    });

    res.json({
      agent_id: agentId,
      available_balance: parseFloat(parseFloat(agent.balance).toFixed(6)),
      total_locked: parseFloat(parseFloat(agent.escrow || 0).toFixed(6)),
      locked_order_count: breakdown.length,
      breakdown,
    });
  } catch (err) { next(err); }
});

// GET /agents/me/balance-history — paginated log of all balance changes (orders, withdrawals, deposits, tips)
router.get('/me/balance-history', requireApiKey, async (req, res, next) => {
  try {
    const agentId = req.agent.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const type = req.query.type; // 'order' | 'deposit' | 'withdrawal' | 'tip'

    const events = [];

    // Completed orders as seller (credit) and buyer (debit)
    const orders = await dbAll(
      `SELECT o.id, o.amount, o.completed_at as ts, o.seller_id, o.buyer_id,
              s.name as service_name
       FROM orders o
       LEFT JOIN services s ON o.service_id = s.id
       WHERE (o.seller_id = ${p(1)} OR o.buyer_id = ${p(2)}) AND o.status = 'completed'`,
      [agentId, agentId]
    ).catch(() => []);

    for (const o of orders) {
      if (o.seller_id === agentId) {
        events.push({ type: 'order_credit', amount: parseFloat((o.amount * 0.975).toFixed(6)), ref_id: o.id, description: `Sale: ${o.service_name || 'order'}`, ts: o.ts });
      } else {
        events.push({ type: 'order_debit', amount: -parseFloat(o.amount), ref_id: o.id, description: `Purchase: ${o.service_name || 'order'}`, ts: o.ts });
      }
    }

    // Deposits
    const deposits = await dbAll(
      `SELECT id, amount, confirmed_at as ts FROM deposits WHERE agent_id = ${p(1)}`,
      [agentId]
    ).catch(() => []);
    for (const d of deposits) {
      events.push({ type: 'deposit', amount: parseFloat(d.amount), ref_id: d.id, description: 'USDC deposit', ts: d.ts });
    }

    // Withdrawals
    const withdrawals = await dbAll(
      `SELECT id, amount, created_at as ts FROM withdrawals WHERE agent_id = ${p(1)} AND status = 'completed'`,
      [agentId]
    ).catch(() => []);
    for (const w of withdrawals) {
      events.push({ type: 'withdrawal', amount: -parseFloat(w.amount), ref_id: w.id, description: 'USDC withdrawal', ts: w.ts });
    }

    // Tips sent and received
    const tips = await dbAll(
      `SELECT id, amount, created_at as ts, from_id, to_id FROM tips WHERE from_id = ${p(1)} OR to_id = ${p(2)}`,
      [agentId, agentId]
    ).catch(() => []);
    for (const t of tips) {
      if (t.to_id === agentId) {
        events.push({ type: 'tip_received', amount: parseFloat(t.amount), ref_id: t.id, description: 'Tip received', ts: t.ts });
      } else {
        events.push({ type: 'tip_sent', amount: -parseFloat(t.amount), ref_id: t.id, description: 'Tip sent', ts: t.ts });
      }
    }

    // Sort, optionally filter by type, paginate
    const sorted = events
      .filter(e => !type || e.type === type || (type === 'order' && e.type.startsWith('order')))
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));

    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);

    res.json({ count: total, limit, offset, events: page });
  } catch (err) { next(err); }
});

// GET /agents/me/analytics — seller analytics: revenue 30d, category breakdown, top buyers, service perf
router.get('/me/analytics', requireApiKey, async (req, res, next) => {
  try {
    const agentId = req.agent.id;
    const days = Math.min(parseInt(req.query.days) || 30, 90);

    const [
      dailyRevenue,
      categoryBreakdown,
      topBuyers,
      servicePerf,
      totals,
    ] = await Promise.all([
      // Daily revenue as seller (last N days)
      dbAll(
        `SELECT DATE(completed_at) as day,
                COUNT(*) as order_count,
                SUM(amount * 0.975) as revenue
         FROM orders
         WHERE seller_id = ${p(1)} AND status = 'completed'
           AND completed_at >= datetime('now', ${p(2)})
         GROUP BY DATE(completed_at)
         ORDER BY day ASC`,
        [agentId, `-${days} days`]
      ).catch(() => dbAll(
        `SELECT DATE(completed_at) as day,
                COUNT(*) as order_count,
                SUM(amount * 0.975) as revenue
         FROM orders
         WHERE seller_id = $1 AND status = 'completed'
           AND completed_at >= NOW() - INTERVAL '${days} days'
         GROUP BY DATE(completed_at)
         ORDER BY day ASC`,
        [agentId]
      ).catch(() => [])),

      // Category breakdown (completed sales)
      dbAll(
        `SELECT s.category,
                COUNT(o.id) as order_count,
                SUM(o.amount) as gross_volume,
                SUM(o.amount * 0.975) as net_revenue
         FROM orders o
         JOIN services s ON o.service_id = s.id
         WHERE o.seller_id = ${p(1)} AND o.status = 'completed'
         GROUP BY s.category
         ORDER BY net_revenue DESC`,
        [agentId]
      ).catch(() => []),

      // Top buyers (by spend with this seller)
      dbAll(
        `SELECT a.id, a.name,
                COUNT(o.id) as order_count,
                SUM(o.amount) as total_spent
         FROM orders o
         JOIN agents a ON a.id = o.buyer_id
         WHERE o.seller_id = ${p(1)} AND o.status = 'completed'
         GROUP BY a.id, a.name
         ORDER BY total_spent DESC
         LIMIT 5`,
        [agentId]
      ).catch(() => []),

      // Service performance
      dbAll(
        `SELECT s.id, s.name, s.price, s.category,
                COUNT(o.id) as total_orders,
                SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN o.status = 'disputed' THEN 1 ELSE 0 END) as disputes,
                SUM(CASE WHEN o.status = 'completed' THEN o.amount * 0.975 ELSE 0 END) as revenue,
                AVG(CASE WHEN r.rating IS NOT NULL THEN r.rating ELSE NULL END) as avg_rating
         FROM services s
         LEFT JOIN orders o ON o.service_id = s.id AND o.status NOT IN ('cancelled','refunded')
         LEFT JOIN reviews r ON r.order_id = o.id
         WHERE s.agent_id = ${p(1)}
         GROUP BY s.id, s.name, s.price, s.category
         ORDER BY revenue DESC`,
        [agentId]
      ).catch(() => []),

      // Overall totals
      dbGet(
        `SELECT COUNT(*) as total_orders,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_orders,
                SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed_orders,
                SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as gross_revenue,
                SUM(CASE WHEN status = 'completed' THEN amount * 0.975 ELSE 0 END) as net_revenue,
                MIN(created_at) as first_order_at
         FROM orders WHERE seller_id = ${p(1)}`,
        [agentId]
      ).catch(() => ({})),
    ]);

    const total = totals || {};
    const completedOrders = parseInt(total.completed_orders || 0);
    const totalOrders = parseInt(total.total_orders || 0);

    res.json({
      agent_id: agentId,
      period_days: days,
      summary: {
        total_orders: totalOrders,
        completed_orders: completedOrders,
        disputed_orders: parseInt(total.disputed_orders || 0),
        completion_rate: totalOrders > 0 ? parseFloat((completedOrders / totalOrders * 100).toFixed(1)) : 0,
        gross_revenue: parseFloat(parseFloat(total.gross_revenue || 0).toFixed(4)),
        net_revenue: parseFloat(parseFloat(total.net_revenue || 0).toFixed(4)),
        first_order_at: total.first_order_at || null,
      },
      daily_revenue: dailyRevenue.map(d => ({
        day: d.day,
        order_count: parseInt(d.order_count),
        revenue: parseFloat(parseFloat(d.revenue || 0).toFixed(4)),
      })),
      by_category: categoryBreakdown.map(c => ({
        category: c.category,
        order_count: parseInt(c.order_count),
        gross_volume: parseFloat(parseFloat(c.gross_volume || 0).toFixed(4)),
        net_revenue: parseFloat(parseFloat(c.net_revenue || 0).toFixed(4)),
      })),
      top_buyers: topBuyers.map(b => ({
        id: b.id,
        name: b.name,
        order_count: parseInt(b.order_count),
        total_spent: parseFloat(parseFloat(b.total_spent || 0).toFixed(4)),
      })),
      services: servicePerf.map(s => ({
        id: s.id,
        name: s.name,
        price: parseFloat(s.price),
        category: s.category,
        total_orders: parseInt(s.total_orders || 0),
        completed: parseInt(s.completed || 0),
        disputes: parseInt(s.disputes || 0),
        revenue: parseFloat(parseFloat(s.revenue || 0).toFixed(4)),
        avg_rating: s.avg_rating ? parseFloat(parseFloat(s.avg_rating).toFixed(2)) : null,
      })),
    });
  } catch (err) { next(err); }
});

// GET /agents/search — public, search agents by name/description
router.get('/search', async (req, res, next) => {
  try {
    const q = req.query.q;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    if (!q || !q.trim()) return res.status(400).json({ error: 'q (search query) is required' });
    const kw = `%${q.trim()}%`;
    const agents = await dbAll(
      `SELECT id, name, description, COALESCE(reputation_score, 0) as reputation_score,
              (SELECT COUNT(*) FROM orders WHERE seller_id = a.id AND status = 'completed') as completed_sales
       FROM agents a
       WHERE (a.name LIKE ${p(1)} OR a.description LIKE ${p(2)})
       ORDER BY COALESCE(a.reputation_score, 0) DESC
       LIMIT ${p(3)}`,
      [kw, kw, limit]
    );
    res.json({
      count: agents.length,
      query: q.trim(),
      agents: agents.map(a => ({
        ...a,
        reputation_score: parseInt(a.reputation_score || 0),
        completed_sales: parseInt(a.completed_sales || 0),
      })),
    });
  } catch (err) { next(err); }
});

// GET /agents/:id/activity — public activity feed (recent transactions + rep events)
// Placed BEFORE leaderboard so /:id doesn't shadow it via exact-match
router.get('/:id/activity', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, COALESCE(reputation_score, 0) as reputation_score FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const [orders, repHistory] = await Promise.all([
      dbAll(
        `SELECT o.id, o.status, o.amount, o.created_at, o.completed_at,
                s.name as service_name,
                CASE WHEN o.buyer_id = ${p(2)} THEN 'buyer' ELSE 'seller' END as role
         FROM orders o
         LEFT JOIN services s ON o.service_id = s.id
         WHERE o.buyer_id = ${p(3)} OR o.seller_id = ${p(4)}
         ORDER BY o.created_at DESC LIMIT ${p(5)}`,
        [req.params.id, req.params.id, req.params.id, req.params.id, limit]
      ),
      dbAll(
        `SELECT delta, reason, order_id, created_at FROM reputation_history
         WHERE agent_id = ${p(1)} ORDER BY created_at DESC LIMIT 20`,
        [req.params.id]
      ),
    ]);

    // Merge and sort activity events by date
    const events = [
      ...orders.map(o => ({
        type: 'order',
        id: o.id,
        label: o.role === 'buyer' ? `Placed order: ${o.service_name || 'service'}` : `Received order: ${o.service_name || 'service'}`,
        status: o.status,
        amount: o.amount,
        role: o.role,
        timestamp: o.completed_at || o.created_at,
      })),
      ...repHistory.map(r => ({
        type: 'reputation',
        delta: r.delta,
        reason: r.reason,
        order_id: r.order_id,
        timestamp: r.created_at,
      })),
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, limit);

    res.json({
      agent_id: agent.id,
      name: agent.name,
      reputation_score: parseInt(agent.reputation_score),
      event_count: events.length,
      events,
    });
  } catch (err) { next(err); }
});

// GET /agents/leaderboard — public, top agents by reputation
// Supports: ?limit=20&category=coding&q=searchName
router.get('/leaderboard', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const category = req.query.category;
    const q = req.query.q;

    let query, params;
    if (category) {
      // Rank by category-specific score
      query = `SELECT a.id, a.name, a.description,
                      COALESCE(a.reputation_score, 0) as reputation_score,
                      COALESCE(rbc.score, 0) as category_score,
                      COALESCE(rbc.order_count, 0) as category_orders,
                      (SELECT COUNT(*) FROM orders WHERE seller_id = a.id AND status = 'completed') as completed_sales
               FROM agents a
               LEFT JOIN reputation_by_category rbc ON rbc.agent_id = a.id AND rbc.category = ${p(1)}
               ${q ? `WHERE a.name LIKE ${p(2)}` : ''}
               ORDER BY COALESCE(rbc.score, 0) DESC, COALESCE(a.reputation_score, 0) DESC
               LIMIT ${p(q ? 3 : 2)}`;
      params = q ? [category, `%${q}%`, limit] : [category, limit];
    } else {
      query = `SELECT a.id, a.name, a.description,
                      COALESCE(a.reputation_score, 0) as reputation_score,
                      (SELECT COUNT(*) FROM orders WHERE seller_id = a.id AND status = 'completed') as completed_sales
               FROM agents a
               ${q ? `WHERE a.name LIKE ${p(1)}` : ''}
               ORDER BY COALESCE(a.reputation_score, 0) DESC, a.created_at ASC
               LIMIT ${p(q ? 2 : 1)}`;
      params = q ? [`%${q}%`, limit] : [limit];
    }
    const agents = await dbAll(query, params);
    res.json({ count: agents.length, category: category || null, agents: agents.map(a => ({
      ...a,
      reputation_score: parseInt(a.reputation_score || 0),
      completed_sales: parseInt(a.completed_sales || 0),
      ...(category ? { category_score: parseInt(a.category_score || 0), category_orders: parseInt(a.category_orders || 0) } : {}),
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

// GET /agents/:id/public-profile — public, safe subset of agent data for profile pages
router.get('/:id/public-profile', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, description, COALESCE(reputation_score, 0) as reputation_score, created_at
       FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const [sales, purchases] = await Promise.all([
      dbGet(`SELECT COUNT(*) as c FROM orders WHERE seller_id = ${p(1)} AND status = 'completed'`, [req.params.id]),
      dbGet(`SELECT COUNT(*) as c FROM orders WHERE buyer_id = ${p(1)} AND status = 'completed'`, [req.params.id]),
    ]);
    res.json({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      reputation_score: parseInt(agent.reputation_score || 0),
      created_at: agent.created_at,
      completed_sales: parseInt(sales?.c || 0),
      completed_purchases: parseInt(purchases?.c || 0),
    });
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

// GET /agents/:id/services — shortcut for GET /services?agent_id=:id (no auth, public)
router.get('/:id/services', async (req, res, next) => {
  try {
    const { dbAll: svcAll } = require('../db/helpers');
    const agentId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const isPostgres = !!process.env.DATABASE_URL;
    const pp = (n) => isPostgres ? `$${n}` : '?';
    const services = await svcAll(
      `SELECT id, name, description, price, category, delivery_hours, is_active, auto_verify, created_at
       FROM services WHERE agent_id = ${pp(1)} AND (is_active = 1 OR is_active = true)
       ORDER BY created_at DESC LIMIT ${pp(2)}`,
      [agentId, limit]
    );
    res.json({ count: services.length, agent_id: agentId, services });
  } catch (err) { next(err); }
});

// GET /agents/:id/trust-score — composite trust score (0-100) combining rep, completion, dispute rate, rating, age
router.get('/:id/trust-score', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, COALESCE(reputation_score, 0) as reputation_score, created_at FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const [orderStats, avgRating, reviewCount] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='disputed' THEN 1 ELSE 0 END) as disputed
         FROM orders WHERE seller_id = ${p(1)}`,
        [req.params.id]
      ),
      dbGet(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE seller_id = ${p(1)}`,
        [req.params.id]
      ).catch(() => null),
      dbGet(
        `SELECT COUNT(*) as count FROM reviews WHERE seller_id = ${p(1)}`,
        [req.params.id]
      ).catch(() => ({ count: 0 })),
    ]);

    const total = parseInt(orderStats?.total || 0);
    const completed = parseInt(orderStats?.completed || 0);
    const disputed = parseInt(orderStats?.disputed || 0);
    const completionRate = total > 0 ? completed / total : 0;
    const disputeRate = total > 0 ? disputed / total : 0;
    const repScore = parseInt(agent.reputation_score);
    const avgRatingVal = parseFloat(avgRating?.avg_rating || 0);
    const numReviews = parseInt(avgRating?.count || 0);

    // Account age bonus (days since registration, capped at 30 days → 10pts)
    const ageMs = Date.now() - new Date(agent.created_at).getTime();
    const ageDays = Math.min(ageMs / 86400000, 30);

    // Composite score components (out of 100):
    // reputation (0-200 raw → normalized to 0-30), completion rate (0-25), dispute penalty (0-20),
    // avg rating (0-25), account age (0-10), review volume bonus (0-10)
    const repComponent = Math.min(Math.max(repScore, 0) / 200 * 30, 30);
    const completionComponent = completionRate * 25;
    const disputePenalty = Math.min(disputeRate * 40, 20);
    const ratingComponent = numReviews > 0 ? (avgRatingVal / 5) * 25 : 12.5; // neutral if no reviews
    const ageComponent = (ageDays / 30) * 10;
    const reviewBonus = Math.min(numReviews * 0.5, 10);

    const rawScore = repComponent + completionComponent - disputePenalty + ratingComponent + ageComponent + reviewBonus;
    const score = Math.min(Math.max(Math.round(rawScore), 0), 100);

    let level, level_desc;
    if (score >= 90)      { level = 'Elite';   level_desc = 'Exceptional track record — highly trusted'; }
    else if (score >= 70) { level = 'Trusted'; level_desc = 'Consistent performance — safe to transact'; }
    else if (score >= 45) { level = 'Rising';  level_desc = 'Building reputation — proceed with normal caution'; }
    else                  { level = 'New';     level_desc = 'Limited history — standard caution advised'; }

    res.json({
      agent_id: agent.id,
      name: agent.name,
      trust_score: score,
      level,
      level_desc,
      signals: {
        reputation_score: repScore,
        total_orders_as_seller: total,
        completion_rate: parseFloat((completionRate * 100).toFixed(1)),
        dispute_rate: parseFloat((disputeRate * 100).toFixed(1)),
        avg_rating: numReviews > 0 ? parseFloat(avgRatingVal.toFixed(2)) : null,
        review_count: numReviews,
        account_age_days: Math.floor(ageDays),
      },
      components: {
        reputation: parseFloat(repComponent.toFixed(1)),
        completion: parseFloat(completionComponent.toFixed(1)),
        dispute_penalty: parseFloat(disputePenalty.toFixed(1)),
        rating: parseFloat(ratingComponent.toFixed(1)),
        age: parseFloat(ageComponent.toFixed(1)),
        review_bonus: parseFloat(reviewBonus.toFixed(1)),
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
