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
// Query params: q (keyword), min_trust (0-100), category, sort (trust|reputation|completion), limit
router.get('/search', async (req, res, next) => {
  try {
    const q = req.query.q;
    const minTrust = parseInt(req.query.min_trust) || 0;
    const category = req.query.category;
    const sort = req.query.sort || 'reputation'; // trust|reputation|completion
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    // Build WHERE conditions
    const conditions = [];
    const params = [];
    let pIdx = 1;

    if (q && q.trim()) {
      const kw = `%${q.trim()}%`;
      conditions.push(`(a.name LIKE ${p(pIdx)} OR a.description LIKE ${p(pIdx + 1)})`);
      params.push(kw, kw);
      pIdx += 2;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const agents = await dbAll(
      `SELECT a.id, a.name, a.description,
              COALESCE(a.reputation_score, 0) as reputation_score,
              a.created_at,
              (SELECT COUNT(*) FROM orders WHERE seller_id = a.id AND status = 'completed') as completed_sales,
              (SELECT COUNT(*) FROM orders WHERE seller_id = a.id) as total_sales,
              (SELECT COUNT(*) FROM orders WHERE seller_id = a.id AND status IN ('disputed','refunded')) as disputes,
              (SELECT AVG(rating) FROM reviews WHERE seller_id = a.id) as avg_rating,
              (SELECT COUNT(*) FROM reviews WHERE seller_id = a.id) as review_count
       FROM agents a
       ${whereClause}
       ORDER BY COALESCE(a.reputation_score, 0) DESC
       LIMIT ${p(pIdx)}`,
      [...params, limit * 5] // fetch extra to allow post-filter by trust
    );

    // Compute trust score inline (same formula as /:id/trust-score)
    function computeTrust(a) {
      const total = parseInt(a.total_sales || 0);
      const completed = parseInt(a.completed_sales || 0);
      const disputed = parseInt(a.disputes || 0);
      const rep = parseInt(a.reputation_score || 0);
      const avgRating = parseFloat(a.avg_rating || 0);
      const numReviews = parseInt(a.review_count || 0);
      const ageDays = Math.min((Date.now() - new Date(a.created_at).getTime()) / 86400000, 30);

      const completionRate = total > 0 ? completed / total : 0;
      const disputeRate = total > 0 ? disputed / total : 0;

      const repPts     = Math.min(Math.max(rep, 0) / 200 * 30, 30);
      const compPts    = completionRate * 25;
      const dispPenalty = Math.min(disputeRate * 40, 20);
      const ratingPts  = numReviews > 0 ? (avgRating / 5) * 25 : 12.5;
      const agePts     = (ageDays / 30) * 10;
      const revBonus   = Math.min(numReviews * 0.5, 10);

      const raw = repPts + compPts - dispPenalty + ratingPts + agePts + revBonus;
      return Math.min(Math.max(Math.round(raw), 0), 100);
    }

    function trustLevel(score) {
      if (score >= 90) return 'Elite';
      if (score >= 70) return 'Trusted';
      if (score >= 45) return 'Rising';
      return 'New';
    }

    let results = agents.map(a => {
      const trust_score = computeTrust(a);
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        reputation_score: parseInt(a.reputation_score || 0),
        completed_sales: parseInt(a.completed_sales || 0),
        completion_rate: parseInt(a.total_sales || 0) > 0
          ? parseFloat((parseInt(a.completed_sales || 0) / parseInt(a.total_sales || 0) * 100).toFixed(1))
          : null,
        avg_rating: a.avg_rating ? parseFloat(parseFloat(a.avg_rating).toFixed(2)) : null,
        trust_score,
        trust_level: trustLevel(trust_score),
      };
    });

    // Filter by min_trust
    if (minTrust > 0) {
      results = results.filter(a => a.trust_score >= minTrust);
    }

    // Filter by category (agents with active services in category)
    if (category) {
      const catAgentIds = new Set(
        (await dbAll(
          `SELECT DISTINCT agent_id FROM services WHERE category = ${p(1)} AND status = 'active'`,
          [category]
        )).map(r => r.agent_id)
      );
      results = results.filter(a => catAgentIds.has(a.id));
    }

    // Sort
    if (sort === 'trust') {
      results.sort((a, b) => b.trust_score - a.trust_score);
    } else if (sort === 'completion') {
      results.sort((a, b) => (b.completion_rate ?? 0) - (a.completion_rate ?? 0));
    }
    // default: already sorted by reputation from DB

    results = results.slice(0, limit);

    res.json({
      count: results.length,
      query: q ? q.trim() : null,
      filters: {
        min_trust: minTrust || null,
        category: category || null,
        sort,
      },
      agents: results,
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

// GET /agents/:id/reputation-history — paginated public reputation event log
router.get('/:id/reputation-history', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, COALESCE(reputation_score, 0) as reputation_score FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const reason = req.query.reason; // optional filter: 'order_completed','dispute_lost','tip_received', etc.

    const countParams = [req.params.id];
    const dataParams  = [req.params.id];
    let reasonFilter  = '';
    if (reason) {
      reasonFilter = ` AND reason = ${p(2)}`;
      countParams.push(reason);
      dataParams.push(reason);
    }

    const [total, events] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) as cnt FROM reputation_history WHERE agent_id = ${p(1)}${reasonFilter}`,
        countParams
      ),
      dbAll(
        `SELECT id, delta, reason, order_id, created_at
         FROM reputation_history
         WHERE agent_id = ${p(1)}${reasonFilter}
         ORDER BY created_at DESC
         LIMIT ${p(dataParams.length + 1)} OFFSET ${p(dataParams.length + 2)}`,
        [...dataParams, limit, offset]
      ),
    ]);

    const totalCount = parseInt(total?.cnt || 0);
    res.json({
      agent_id: agent.id,
      name: agent.name,
      current_score: parseInt(agent.reputation_score),
      pagination: {
        page,
        limit,
        total: totalCount,
        pages: Math.ceil(totalCount / limit),
        has_next: page * limit < totalCount,
        has_prev: page > 1,
      },
      events: events.map(e => ({
        id: e.id,
        delta: e.delta,
        direction: e.delta > 0 ? 'up' : 'down',
        reason: e.reason,
        order_id: e.order_id || null,
        created_at: e.created_at,
      })),
    });
  } catch (err) { next(err); }
});

// GET /agents/:id/capabilities — machine-readable capability declaration (A2A discovery)
// Returns all active services as structured capability objects with input schemas
router.get('/:id/capabilities', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, description, COALESCE(reputation_score, 0) as reputation_score, created_at
       FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const services = await dbAll(
      `SELECT id, name, description, price, delivery_hours, category, input_schema, auto_verify, status
       FROM services WHERE agent_id = ${p(1)} AND status = 'active'
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    const capabilities = services.map(s => ({
      service_id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      price_usdc: s.price,
      delivery_hours: s.delivery_hours,
      auto_verify: !!s.auto_verify,
      input_schema: s.input_schema
        ? (typeof s.input_schema === 'string' ? JSON.parse(s.input_schema) : s.input_schema)
        : null,
    }));

    const categories = [...new Set(capabilities.map(c => c.category).filter(Boolean))];

    res.json({
      agent_id: agent.id,
      name: agent.name,
      description: agent.description,
      reputation_score: parseInt(agent.reputation_score),
      active_services: capabilities.length,
      categories,
      capabilities,
      profile_url: `https://a2a-system.onrender.com/profile?id=${agent.id}`,
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

// POST /agents/pay — direct agent-to-agent USDC transfer (no escrow, no service required)
// Useful for referral fees, pre-payments, gratuities outside of orders.
router.post('/pay', requireApiKey, async (req, res, next) => {
  try {
    const { to_agent_id, amount, memo } = req.body;
    if (!to_agent_id) return res.status(400).json({ error: 'to_agent_id is required' });
    const n = parseFloat(amount);
    if (!(n >= 0.01)) return res.status(400).json({ error: 'amount must be at least 0.01 USDC' });
    if (to_agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot pay yourself' });

    const [sender, recipient] = await Promise.all([
      dbGet(`SELECT id, name, balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]),
      dbGet(`SELECT id, name FROM agents WHERE id = ${p(1)}`, [to_agent_id]),
    ]);
    if (!recipient) return res.status(404).json({ error: 'Recipient agent not found' });
    if (parseFloat(sender.balance) < n) {
      return res.status(400).json({ error: 'Insufficient balance', balance: sender.balance, required: n });
    }

    const paymentId = uuidv4();
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [n, req.agent.id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [n, to_agent_id]);

    // Log in balance_events for both agents
    await dbRun(
      `INSERT INTO balance_events (id, agent_id, type, amount, description, created_at)
       VALUES (${p(1)},${p(2)},'direct_pay_sent',${p(3)},${p(4)},${now})`,
      [uuidv4(), req.agent.id, -n, memo ? `To ${recipient.name}: ${memo}` : `Direct payment to ${recipient.name}`]
    ).catch(() => {}); // table may not exist in older deployments

    await dbRun(
      `INSERT INTO balance_events (id, agent_id, type, amount, description, created_at)
       VALUES (${p(1)},${p(2)},'direct_pay_received',${p(3)},${p(4)},${now})`,
      [uuidv4(), to_agent_id, n, memo ? `From ${sender.name}: ${memo}` : `Direct payment from ${sender.name}`]
    ).catch(() => {});

    const updatedBalance = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);

    res.json({
      payment_id: paymentId,
      from_id: req.agent.id,
      to_id: to_agent_id,
      to_name: recipient.name,
      amount: n,
      memo: memo || null,
      sender_balance: parseFloat(updatedBalance.balance),
      created_at: new Date().toISOString(),
      message: `Sent ${n} USDC to ${recipient.name}.`,
    });
  } catch (err) { next(err); }
});

// GET /agents/:id/network — public transaction network graph
// Returns agents this agent has transacted with (as buyer and seller), with
// mutual transaction counts and completion rates. Used by other agents to
// assess social proof: "who has already trusted this agent?"
router.get('/:id/network', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, COALESCE(reputation_score, 0) as reputation_score FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    // Agents this agent bought from (as buyer)
    const boughtFrom = await dbAll(
      `SELECT a.id, a.name, COALESCE(a.reputation_score, 0) as reputation_score,
              COUNT(o.id) as total_orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(o.amount) as total_usdc
       FROM orders o
       JOIN agents a ON a.id = o.seller_id
       WHERE o.buyer_id = ${p(1)}
       GROUP BY a.id, a.name, a.reputation_score
       ORDER BY completed DESC, total_orders DESC
       LIMIT ${p(2)}`,
      [req.params.id, limit]
    ).catch(() => []);

    // Agents that bought from this agent (as seller)
    const soldTo = await dbAll(
      `SELECT a.id, a.name, COALESCE(a.reputation_score, 0) as reputation_score,
              COUNT(o.id) as total_orders,
              SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(o.amount) as total_usdc
       FROM orders o
       JOIN agents a ON a.id = o.buyer_id
       WHERE o.seller_id = ${p(1)}
       GROUP BY a.id, a.name, a.reputation_score
       ORDER BY completed DESC, total_orders DESC
       LIMIT ${p(2)}`,
      [req.params.id, limit]
    ).catch(() => []);

    const formatNode = (row) => ({
      agent_id: row.id,
      name: row.name,
      reputation_score: parseInt(row.reputation_score || 0),
      total_orders: parseInt(row.total_orders || 0),
      completed_orders: parseInt(row.completed || 0),
      completion_rate: parseInt(row.total_orders || 0) > 0
        ? parseFloat((parseInt(row.completed || 0) / parseInt(row.total_orders || 0) * 100).toFixed(1))
        : 0,
      total_usdc: parseFloat(parseFloat(row.total_usdc || 0).toFixed(2)),
    });

    res.json({
      agent_id: agent.id,
      name: agent.name,
      network_size: boughtFrom.length + soldTo.length,
      bought_from: boughtFrom.map(formatNode),
      sold_to: soldTo.map(formatNode),
    });
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

// GET /agents/me/insights — AI-generated business insights for the seller (requires ANTHROPIC_API_KEY)
router.get('/me/insights', requireApiKey, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI insights not available: ANTHROPIC_API_KEY not configured' });
    }

    const agentId = req.agent.id;

    // Gather seller data
    const [agent, orderStats, byCategory, topBuyers, recentRep] = await Promise.all([
      dbGet(`SELECT id, name, COALESCE(reputation_score,0) as reputation_score, created_at FROM agents WHERE id = ${p(1)}`, [agentId]),
      dbGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='disputed' THEN 1 ELSE 0 END) as disputed,
                SUM(CASE WHEN status='completed' THEN amount*0.975 ELSE 0 END) as net_revenue
         FROM orders WHERE seller_id=${p(1)}`,
        [agentId]
      ),
      dbAll(
        `SELECT s.category, COUNT(o.id) as cnt, SUM(o.amount*0.975) as rev
         FROM orders o JOIN services s ON o.service_id=s.id
         WHERE o.seller_id=${p(1)} AND o.status='completed' GROUP BY s.category ORDER BY rev DESC LIMIT 5`,
        [agentId]
      ).catch(() => []),
      dbAll(
        `SELECT a.name, COUNT(o.id) as cnt FROM orders o JOIN agents a ON a.id=o.buyer_id
         WHERE o.seller_id=${p(1)} AND o.status='completed' GROUP BY a.id,a.name ORDER BY cnt DESC LIMIT 3`,
        [agentId]
      ).catch(() => []),
      dbAll(
        `SELECT delta, reason FROM reputation_history WHERE agent_id=${p(1)} ORDER BY created_at DESC LIMIT 10`,
        [agentId]
      ).catch(() => []),
    ]);

    const stats = orderStats || {};
    const total = parseInt(stats.total || 0);
    const completed = parseInt(stats.completed || 0);
    const disputed = parseInt(stats.disputed || 0);

    const dataContext = `
Agent: ${agent.name}
Reputation: ${agent.reputation_score}
Total orders as seller: ${total}
Completed: ${completed} (${total > 0 ? ((completed/total)*100).toFixed(0) : 0}%)
Disputed: ${disputed}
Net revenue: ${parseFloat(stats.net_revenue || 0).toFixed(2)} USDC
Top categories: ${byCategory.map(c => `${c.category} (${c.cnt} orders, ${parseFloat(c.rev||0).toFixed(2)} USDC)`).join(', ') || 'none'}
Top buyers: ${topBuyers.map(b => `${b.name} (${b.cnt} orders)`).join(', ') || 'none'}
Recent rep changes: ${recentRep.map(r => `${r.delta>0?'+':''}${r.delta} (${r.reason})`).join(', ') || 'none'}
`.trim();

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a business advisor for AI agents selling services on the Arbitova marketplace. Analyze this seller's data and give 3 concise, actionable insights (each under 2 sentences). Focus on: what's working, what to improve, and one growth opportunity. Be specific and practical.\n\n${dataContext}`,
      }],
    });

    const text = msg.content?.[0]?.text || '';
    // Parse numbered insights
    const lines = text.split('\n').filter(l => l.trim());

    res.json({
      agent_id: agentId,
      name: agent.name,
      generated_at: new Date().toISOString(),
      insights: lines.filter(l => l.trim()).slice(0, 6),
      raw: text,
      data_snapshot: {
        reputation: parseInt(agent.reputation_score),
        completion_rate: total > 0 ? parseFloat((completed/total*100).toFixed(1)) : 0,
        net_revenue: parseFloat(parseFloat(stats.net_revenue||0).toFixed(2)),
        top_category: byCategory[0]?.category || null,
      },
    });
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

// GET /agents/:id/credentials — public credential list (no auth)
const { getPublicCredentials } = require('./credentials');
router.get('/:id/credentials', getPublicCredentials);

// GET /agents/:id/due-diligence — comprehensive agent evaluation report (no auth)
// Returns trust score, credentials, network stats, risk level, and recommendations.
// One-call evaluation for orchestrators deciding whether to engage a seller.
router.get('/:id/due-diligence', async (req, res, next) => {
  try {
    const agent = await dbGet(`SELECT * FROM agents WHERE id = ${p(1)}`, [req.params.id]);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const agentId = agent.id;

    // Run all stats queries in parallel
    const selfAttested = isPostgres ? 'FALSE' : '0';
    const isPublicTrue = isPostgres ? 'TRUE' : '1';
    const last30days   = isPostgres ? "NOW() - INTERVAL '30 days'" : "datetime('now', '-30 days')";

    const [orderStats, disputeStats, reviewStats, credStats, networkStats, repHistory] = await Promise.all([
      dbGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                COALESCE(SUM(CASE WHEN status='completed' THEN amount ELSE 0 END), 0) as volume
         FROM orders WHERE seller_id = ${p(1)}`,
        [agentId]
      ),
      dbGet(
        `SELECT COUNT(*) as total_disputes,
                SUM(CASE WHEN d.status='resolved_for_buyer' THEN 1 ELSE 0 END) as lost
         FROM disputes d JOIN orders o ON d.order_id = o.id WHERE o.seller_id = ${p(1)}`,
        [agentId]
      ),
      dbGet(
        `SELECT COUNT(*) as total, AVG(rating) as avg_rating FROM reviews WHERE seller_id = ${p(1)}`,
        [agentId]
      ),
      dbGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN self_attested = ${selfAttested} THEN 1 ELSE 0 END) as verified_count
         FROM agent_credentials WHERE agent_id = ${p(1)} AND is_public = ${isPublicTrue}`,
        [agentId]
      ),
      dbGet(
        `SELECT COUNT(DISTINCT CASE WHEN buyer_id = ${p(1)} THEN seller_id ELSE buyer_id END) as unique_counterparties
         FROM orders WHERE (buyer_id = ${p(2)} OR seller_id = ${p(3)}) AND status = 'completed'`,
        [agentId, agentId, agentId]
      ),
      dbGet(
        `SELECT COUNT(*) as cnt, COALESCE(SUM(delta), 0) as net_30
         FROM reputation_history WHERE agent_id = ${p(1)}
         AND created_at > ${last30days}`,
        [agentId]
      ),
    ]);

    const total     = parseInt(orderStats?.total || 0);
    const completed = parseInt(orderStats?.completed || 0);
    const volume    = parseFloat(orderStats?.volume || 0);
    const totalDisp = parseInt(disputeStats?.total_disputes || 0);
    const lostDisp  = parseInt(disputeStats?.lost || 0);
    const reviews   = parseInt(reviewStats?.total || 0);
    const avgRating = parseFloat(reviewStats?.avg_rating || 0);
    const credTotal = parseInt(credStats?.total || 0);
    const credVerified = parseInt(credStats?.verified_count || 0);
    const counterparties = parseInt(networkStats?.unique_counterparties || 0);
    const reputationTrend30 = parseInt(repHistory?.net_30 || 0);

    const completionRate = total > 0 ? completed / total : null;
    const disputeRate    = total > 0 ? lostDisp / total : null;

    // Compute trust score
    const ageDays = Math.min((Date.now() - new Date(agent.created_at).getTime()) / 86400000, 30);
    const rep = parseInt(agent.reputation_score || 0);
    const repPts      = Math.min(Math.max(rep, 0) / 200 * 30, 30);
    const compPts     = completionRate !== null ? completionRate * 25 : 0;
    const dispPenalty = disputeRate !== null ? Math.min(disputeRate * 40, 20) : 0;
    const ratingPts   = reviews > 0 ? (avgRating / 5) * 25 : 12.5;
    const agePts      = (ageDays / 30) * 10;
    const revBonus    = Math.min(reviews * 0.5, 10);
    const trustScore  = Math.min(Math.max(Math.round(repPts + compPts - dispPenalty + ratingPts + agePts + revBonus), 0), 100);
    const trustLevel  = trustScore >= 90 ? 'Elite' : trustScore >= 70 ? 'Trusted' : trustScore >= 45 ? 'Rising' : 'New';

    // Risk assessment
    const risks = [];
    const positives = [];

    if (total === 0) risks.push('No transaction history');
    if (completionRate !== null && completionRate < 0.7) risks.push(`Low completion rate (${(completionRate * 100).toFixed(0)}%)`);
    if (disputeRate !== null && disputeRate > 0.15) risks.push(`High dispute rate (${(disputeRate * 100).toFixed(0)}%)`);
    if (ageDays < 7) risks.push('New account (< 7 days old)');
    if (parseFloat(agent.stake || 0) === 0) risks.push('No stake locked (no skin in game)');
    if (reputationTrend30 < -20) risks.push('Reputation declining in last 30 days');

    if (completed >= 10) positives.push(`${completed} completed orders`);
    if (completionRate !== null && completionRate >= 0.9) positives.push(`Excellent completion rate (${(completionRate * 100).toFixed(0)}%)`);
    if (credVerified > 0) positives.push(`${credVerified} externally-verified credential(s)`);
    if (counterparties >= 5) positives.push(`Active network: ${counterparties} unique trading partners`);
    if (parseFloat(agent.stake || 0) > 0) positives.push(`${agent.stake} USDC staked (has skin in game)`);
    if (reputationTrend30 > 10) positives.push(`Reputation rising (+${reputationTrend30} in 30 days)`);
    if (reviews >= 3 && avgRating >= 4.5) positives.push(`High rating: ${avgRating.toFixed(1)}/5 (${reviews} reviews)`);

    const riskLevel = risks.length >= 3 ? 'HIGH'
                    : risks.length >= 1 ? 'MEDIUM'
                    : 'LOW';

    res.json({
      agent_id: agentId,
      name: agent.name,
      description: agent.description,
      account_age_days: Math.floor((Date.now() - new Date(agent.created_at).getTime()) / 86400000),
      stake_usdc: parseFloat(agent.stake || 0),

      trust: {
        score: trustScore,
        level: trustLevel,
        breakdown: {
          reputation: parseFloat(repPts.toFixed(1)),
          completion: parseFloat(compPts.toFixed(1)),
          rating: parseFloat(ratingPts.toFixed(1)),
          age: parseFloat(agePts.toFixed(1)),
          dispute_penalty: -parseFloat(dispPenalty.toFixed(1)),
          review_bonus: parseFloat(revBonus.toFixed(1)),
        }
      },

      activity: {
        total_orders: total,
        completed_orders: completed,
        completion_rate: completionRate !== null ? parseFloat((completionRate * 100).toFixed(1)) : null,
        total_volume_usdc: parseFloat(volume.toFixed(2)),
        total_disputes: totalDisp,
        disputes_lost: lostDisp,
        dispute_rate: disputeRate !== null ? parseFloat((disputeRate * 100).toFixed(1)) : null,
        unique_counterparties: counterparties,
      },

      reviews: {
        count: reviews,
        avg_rating: reviews > 0 ? parseFloat(avgRating.toFixed(2)) : null,
      },

      credentials: {
        total: credTotal,
        externally_verified: credVerified,
        self_attested: credTotal - credVerified,
      },

      reputation_trend_30d: reputationTrend30,
      current_reputation_score: rep,

      risk_assessment: {
        risk_level: riskLevel,
        risks,
        positives,
        recommendation: riskLevel === 'LOW'
          ? 'Low risk. Safe to engage for standard or high-value orders.'
          : riskLevel === 'MEDIUM'
          ? 'Moderate risk. Consider starting with a smaller order or requiring stake.'
          : 'High risk. Exercise caution. Use escrow with dispute protection and AI arbitration.',
      },

      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// GET /agents/me/pending-actions — single endpoint for autonomous agents to know what needs action right now.
// Returns a prioritized action queue. Poll this every few minutes instead of monitoring each endpoint separately.
router.get('/me/pending-actions', requireApiKey, async (req, res, next) => {
  try {
    const id = req.agent.id;
    const now = isPostgres ? 'NOW()' : "datetime('now')";
    const p2 = p;

    const [
      pendingDeliveries,
      pendingConfirmations,
      openDisputes,
      pendingCounterOffers,
      overdueAsSeller,
      openRfpApplications,
      unreadMessages,
    ] = await Promise.all([
      // Orders I must deliver (I'm seller, status='paid', not overdue)
      dbAll(
        `SELECT id, amount, deadline, requirements FROM orders
         WHERE seller_id = ${p(1)} AND status = 'paid'
           AND (deadline IS NULL OR deadline >= ${now})
         ORDER BY deadline ASC LIMIT 10`,
        [id]
      ),
      // Deliveries I must confirm (I'm buyer, status='delivered')
      dbAll(
        `SELECT o.id, o.amount, o.deadline, a.name as seller_name
         FROM orders o LEFT JOIN agents a ON a.id = o.seller_id
         WHERE o.buyer_id = ${p(1)} AND o.status = 'delivered'
         ORDER BY o.created_at ASC LIMIT 10`,
        [id]
      ),
      // My orders in dispute
      dbAll(
        `SELECT o.id, o.amount, o.status,
                CASE WHEN o.buyer_id = ${p(1)} THEN 'buyer' ELSE 'seller' END as my_role
         FROM orders o
         WHERE (o.buyer_id = ${p(2)} OR o.seller_id = ${p(3)}) AND o.status = 'disputed'
         LIMIT 10`,
        [id, id, id]
      ),
      // Counter-offers pending my response (I'm buyer, offer is pending)
      dbAll(
        `SELECT id, amount, counter_offer FROM orders
         WHERE buyer_id = ${p(1)} AND status = 'disputed' AND counter_offer IS NOT NULL`,
        [id]
      ).then(rows => rows.filter(r => {
        const c = r.counter_offer ? (typeof r.counter_offer === 'string' ? JSON.parse(r.counter_offer) : r.counter_offer) : null;
        return c && c.status === 'pending';
      })),
      // Overdue: I'm seller and deadline passed
      dbAll(
        `SELECT id, amount, deadline FROM orders
         WHERE seller_id = ${p(1)} AND status = 'paid'
           AND deadline IS NOT NULL AND deadline < ${now}
         ORDER BY deadline ASC LIMIT 10`,
        [id]
      ),
      // RFP applications to review (I'm buyer, request has pending applications)
      dbAll(
        `SELECT r.id, r.title, COUNT(ra.id) as applicant_count
         FROM requests r
         LEFT JOIN request_applications ra ON ra.request_id = r.id AND ra.status = 'pending'
         WHERE r.buyer_id = ${p(1)} AND r.status = 'open'
         GROUP BY r.id, r.title
         HAVING COUNT(ra.id) > 0
         LIMIT 5`,
        [id]
      ).catch(() => []),
      // Unread messages
      dbAll(
        `SELECT COUNT(*) as cnt FROM messages WHERE to_agent_id = ${p(1)} AND is_read = ${isPostgres ? 'false' : '0'}`,
        [id]
      ).catch(() => [{ cnt: 0 }]),
    ]);

    const actions = [];

    for (const o of overdueAsSeller) {
      const hrs = Math.round((Date.now() - new Date(o.deadline).getTime()) / 3600000);
      actions.push({
        priority: 1,
        type: 'overdue_delivery',
        order_id: o.id,
        amount: parseFloat(o.amount),
        overdue_hours: hrs,
        message: `Deliver order ${o.id} — ${hrs}h overdue. Risk of dispute.`,
        action_url: `/orders/${o.id}/deliver`,
      });
    }

    for (const co of pendingCounterOffers) {
      const c = typeof co.counter_offer === 'string' ? JSON.parse(co.counter_offer) : co.counter_offer;
      actions.push({
        priority: 2,
        type: 'counter_offer_pending',
        order_id: co.id,
        refund_amount: c.refund_amount,
        seller_keeps: c.seller_keeps,
        note: c.note,
        message: `Counter-offer awaiting your decision on order ${co.id}: accept ${c.refund_amount} USDC refund or decline and arbitrate.`,
        action_url: `/orders/${co.id}/counter-offer/accept`,
      });
    }

    for (const o of openDisputes) {
      actions.push({
        priority: 3,
        type: 'open_dispute',
        order_id: o.id,
        amount: parseFloat(o.amount),
        my_role: o.my_role,
        message: `Order ${o.id} is disputed. Consider counter-offer or AI arbitration.`,
        action_url: `/orders/${o.id}/auto-arbitrate`,
      });
    }

    for (const o of pendingConfirmations) {
      actions.push({
        priority: 4,
        type: 'confirm_delivery',
        order_id: o.id,
        amount: parseFloat(o.amount),
        seller_name: o.seller_name,
        message: `Delivery received for order ${o.id}. Confirm to release ${o.amount} USDC.`,
        action_url: `/orders/${o.id}/confirm`,
      });
    }

    for (const o of pendingDeliveries) {
      const deadlineMs = o.deadline ? new Date(o.deadline).getTime() : null;
      const hoursLeft = deadlineMs ? Math.round((deadlineMs - Date.now()) / 3600000) : null;
      actions.push({
        priority: 5,
        type: 'pending_delivery',
        order_id: o.id,
        amount: parseFloat(o.amount),
        hours_until_deadline: hoursLeft,
        message: `Deliver order ${o.id}${hoursLeft !== null ? ` (${hoursLeft}h remaining)` : ''}.`,
        action_url: `/orders/${o.id}/deliver`,
      });
    }

    for (const r of openRfpApplications) {
      actions.push({
        priority: 6,
        type: 'rfp_applications_pending',
        request_id: r.id,
        applicant_count: parseInt(r.applicant_count),
        message: `${r.applicant_count} application(s) for your request "${r.title}". Review and accept one.`,
        action_url: `/requests/${r.id}/applications`,
      });
    }

    const unreadCount = parseInt(unreadMessages[0]?.cnt || 0);
    if (unreadCount > 0) {
      actions.push({
        priority: 7,
        type: 'unread_messages',
        count: unreadCount,
        message: `${unreadCount} unread message(s) in your inbox.`,
        action_url: '/messages',
      });
    }

    actions.sort((a, b) => a.priority - b.priority);

    res.json({
      agent_id: id,
      action_count: actions.length,
      actions,
      generated_at: new Date().toISOString(),
      note: 'Poll this endpoint to drive autonomous agent decision loops. Actions are sorted by urgency.',
    });
  } catch (err) { next(err); }
});

// POST /agents/me/away — set agent as "away" (vacation mode).
// While away, new orders to the agent's services are blocked with a friendly error.
// Supports a return date for transparency.
router.post('/me/away', requireApiKey, async (req, res, next) => {
  try {
    const { until, message: awayMsg } = req.body;
    const returnDate = until ? new Date(until) : null;
    if (returnDate && isNaN(returnDate.getTime())) {
      return res.status(400).json({ error: 'Invalid "until" date — use ISO 8601 format' });
    }
    if (returnDate && returnDate < new Date()) {
      return res.status(400).json({ error: '"until" must be in the future' });
    }

    const awayData = JSON.stringify({
      active: true,
      since: new Date().toISOString(),
      until: returnDate ? returnDate.toISOString() : null,
      message: (awayMsg || 'Agent is temporarily unavailable.').slice(0, 300),
    });

    await dbRun(
      `UPDATE agents SET away_mode = ${p(1)} WHERE id = ${p(2)}`,
      [awayData, req.agent.id]
    );

    res.json({
      away: true,
      since: new Date().toISOString(),
      until: returnDate ? returnDate.toISOString() : null,
      message: awayMsg || 'Agent is temporarily unavailable.',
      note: 'New orders to your services will be rejected while away. Existing orders are unaffected.',
    });
  } catch (err) { next(err); }
});

// DELETE /agents/me/away — return from away mode (resume accepting orders)
router.delete('/me/away', requireApiKey, async (req, res, next) => {
  try {
    await dbRun(`UPDATE agents SET away_mode = NULL WHERE id = ${p(1)}`, [req.agent.id]);
    res.json({ away: false, message: 'Away mode disabled. You can now receive new orders.' });
  } catch (err) { next(err); }
});

// GET /agents/:id/scorecard — concise seller performance card.
// Public, no auth required. Returns completion rate, avg rating, dispute rate, credentials, top service.
// Designed for buyers to quickly vet a seller before placing a high-value order.
router.get('/:id/scorecard', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, reputation_score, created_at FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const [orderStats, reviewStats, credStats, topService] = await Promise.all([
      dbGet(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed,
           SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END) as volume
         FROM orders WHERE seller_id = ${p(1)}`,
        [agent.id]
      ),
      dbGet(
        `SELECT COUNT(*) as review_count, AVG(rating) as avg_rating
         FROM reviews WHERE seller_id = ${p(1)}`,
        [agent.id]
      ),
      dbGet(
        `SELECT COUNT(*) as total,
           SUM(CASE WHEN self_attested = 0 OR self_attested = false THEN 1 ELSE 0 END) as verified
         FROM credentials WHERE agent_id = ${p(1)} AND (expires_at IS NULL OR expires_at > ${p(2)})`,
        [agent.id, new Date().toISOString()]
      ),
      dbGet(
        `SELECT s.name, s.price, s.category, s.delivery_hours,
           COUNT(o.id) as order_count
         FROM services s
         LEFT JOIN orders o ON o.service_id = s.id AND o.status = 'completed'
         WHERE s.agent_id = ${p(1)} AND (s.is_active = 1 OR s.is_active = true)
         GROUP BY s.id
         ORDER BY order_count DESC
         LIMIT 1`,
        [agent.id]
      ),
    ]);

    const total = parseInt(orderStats?.total) || 0;
    const completed = parseInt(orderStats?.completed) || 0;
    const disputed = parseInt(orderStats?.disputed) || 0;
    const volume = parseFloat(orderStats?.volume) || 0;
    const completionRate = total > 0 ? parseFloat((completed / total * 100).toFixed(1)) : null;
    const disputeRate = total > 0 ? parseFloat((disputed / total * 100).toFixed(1)) : null;
    const avgRating = reviewStats?.avg_rating ? parseFloat(parseFloat(reviewStats.avg_rating).toFixed(2)) : null;
    const reviewCount = parseInt(reviewStats?.review_count) || 0;
    const credTotal = parseInt(credStats?.total) || 0;
    const credVerified = parseInt(credStats?.verified) || 0;

    const score = agent.reputation_score || 0;
    const trustLevel = score >= 80 ? 'Elite' : score >= 60 ? 'Trusted' : score >= 40 ? 'Rising' : 'New';

    let grade = 'C';
    if (completionRate !== null && completionRate >= 90 && avgRating !== null && avgRating >= 4.0 && score >= 60) {
      grade = 'A';
    } else if (completionRate !== null && completionRate >= 75 && score >= 40) {
      grade = 'B';
    } else if (completionRate !== null && completionRate < 50) {
      grade = 'D';
    }

    res.json({
      agent_id: agent.id,
      name: agent.name,
      trust: { score, level: trustLevel },
      grade,
      performance: {
        total_orders: total,
        completed_orders: completed,
        completion_rate: completionRate,
        dispute_rate: disputeRate,
        total_volume_usdc: parseFloat(volume.toFixed(4)),
      },
      reviews: { count: reviewCount, avg_rating: avgRating },
      credentials: { total: credTotal, verified: credVerified },
      top_service: topService ? {
        name: topService.name,
        price: topService.price,
        category: topService.category,
        delivery_hours: topService.delivery_hours,
        completed_orders: parseInt(topService.order_count) || 0,
      } : null,
      member_since: agent.created_at,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// GET /agents/compare?ids=id1,id2,id3 — side-by-side seller comparison.
// Public, no auth required. Accepts up to 5 agent IDs. Returns scorecard data for each.
// Designed for autonomous buyers who want to pick the best seller from a shortlist.
// Response includes a `recommended` field pointing to the highest-scored agent.
router.get('/compare', async (req, res, next) => {
  try {
    const rawIds = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
    if (rawIds.length < 2) return res.status(400).json({ error: 'Provide at least 2 agent IDs in ?ids=id1,id2' });
    if (rawIds.length > 5) return res.status(400).json({ error: 'Maximum 5 agents can be compared at once' });

    // Fetch scorecard-equivalent data for all agents in parallel
    const results = await Promise.all(rawIds.map(async (agentId) => {
      const agent = await dbGet(
        `SELECT id, name, reputation_score, created_at FROM agents WHERE id = ${p(1)}`,
        [agentId]
      );
      if (!agent) return { agent_id: agentId, error: 'Not found' };

      const [orderStats, reviewStats, credStats] = await Promise.all([
        dbGet(
          `SELECT COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed
           FROM orders WHERE seller_id = ${p(1)}`,
          [agent.id]
        ),
        dbGet(
          `SELECT COUNT(*) as review_count, AVG(rating) as avg_rating FROM reviews WHERE seller_id = ${p(1)}`,
          [agent.id]
        ),
        dbGet(
          `SELECT COUNT(*) as total,
             SUM(CASE WHEN self_attested = 0 OR self_attested = false THEN 1 ELSE 0 END) as verified
           FROM credentials WHERE agent_id = ${p(1)} AND (expires_at IS NULL OR expires_at > ${p(2)})`,
          [agent.id, new Date().toISOString()]
        ),
      ]);

      const total = parseInt(orderStats?.total) || 0;
      const completed = parseInt(orderStats?.completed) || 0;
      const disputed = parseInt(orderStats?.disputed) || 0;
      const completionRate = total > 0 ? parseFloat((completed / total * 100).toFixed(1)) : null;
      const disputeRate = total > 0 ? parseFloat((disputed / total * 100).toFixed(1)) : null;
      const avgRating = reviewStats?.avg_rating ? parseFloat(parseFloat(reviewStats.avg_rating).toFixed(2)) : null;
      const reviewCount = parseInt(reviewStats?.review_count) || 0;
      const credVerified = parseInt(credStats?.verified) || 0;
      const score = agent.reputation_score || 0;
      const trustLevel = score >= 80 ? 'Elite' : score >= 60 ? 'Trusted' : score >= 40 ? 'Rising' : 'New';

      let grade = 'C';
      if (completionRate !== null && completionRate >= 90 && avgRating !== null && avgRating >= 4.0 && score >= 60) grade = 'A';
      else if (completionRate !== null && completionRate >= 75 && score >= 40) grade = 'B';
      else if (completionRate !== null && completionRate < 50) grade = 'D';

      // Composite selection score (0-100)
      const selectionScore = parseFloat((
        (score * 0.35) +
        ((completionRate || 0) * 0.35) +
        ((avgRating || 0) / 5 * 100 * 0.20) +
        (Math.min(credVerified * 5, 10) * 0.10)
      ).toFixed(1));

      return {
        agent_id: agent.id,
        name: agent.name,
        trust: { score, level: trustLevel },
        grade,
        selection_score: selectionScore,
        completion_rate: completionRate,
        dispute_rate: disputeRate,
        avg_rating: avgRating,
        review_count: reviewCount,
        verified_credentials: credVerified,
        member_since: agent.created_at,
      };
    }));

    // Find recommended agent (highest selection_score among non-error results)
    const valid = results.filter(r => !r.error);
    let recommended = null;
    if (valid.length > 0) {
      const best = valid.reduce((a, b) => (a.selection_score >= b.selection_score ? a : b));
      recommended = { agent_id: best.agent_id, name: best.name, reason: `Highest composite score (${best.selection_score}/100)` };
    }

    res.json({
      compared: results.length,
      recommended,
      agents: results,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// ── Blocklist ─────────────────────────────────────────────────────────────────
// Agents can block specific counterparties from placing orders.
// Blocklist is a JSON array of { agent_id, name, reason, blocked_at } objects stored in agents.blocklist.

// GET /agents/me/blocklist — return current blocklist
router.get('/me/blocklist', requireApiKey, async (req, res, next) => {
  try {
    const agent = await dbGet(`SELECT blocklist FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    const blocklist = agent?.blocklist
      ? (typeof agent.blocklist === 'string' ? JSON.parse(agent.blocklist) : agent.blocklist)
      : [];
    res.json({ agent_id: req.agent.id, count: blocklist.length, blocklist });
  } catch (err) { next(err); }
});

// POST /agents/me/blocklist — add an agent to the blocklist
router.post('/me/blocklist', requireApiKey, async (req, res, next) => {
  try {
    const { agent_id, reason } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
    if (agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot block yourself' });

    // Verify the target agent exists
    const target = await dbGet(`SELECT id, name FROM agents WHERE id = ${p(1)}`, [agent_id]);
    if (!target) return res.status(404).json({ error: 'Agent not found' });

    const agentRow = await dbGet(`SELECT blocklist FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    const blocklist = agentRow?.blocklist
      ? (typeof agentRow.blocklist === 'string' ? JSON.parse(agentRow.blocklist) : agentRow.blocklist)
      : [];

    if (blocklist.some(b => b.agent_id === agent_id)) {
      return res.status(409).json({ error: 'Agent is already on your blocklist', agent_id });
    }
    if (blocklist.length >= 50) {
      return res.status(400).json({ error: 'Blocklist limit reached (50). Remove an entry first.' });
    }

    blocklist.push({
      agent_id: target.id,
      name: target.name,
      reason: reason || null,
      blocked_at: new Date().toISOString(),
    });

    await dbRun(`UPDATE agents SET blocklist = ${p(1)} WHERE id = ${p(2)}`, [JSON.stringify(blocklist), req.agent.id]);
    res.status(201).json({
      message: `${target.name} added to blocklist.`,
      agent_id: target.id,
      blocklist_count: blocklist.length,
    });
  } catch (err) { next(err); }
});

// GET /agents/:id/reliability — time-decay weighted reliability score.
// Public, no auth required. Weights recent performance (last 30 days) 3x more than older history.
// More accurate than reputation_score for current performance assessment.
router.get('/:id/reliability', async (req, res, next) => {
  try {
    const agent = await dbGet(
      `SELECT id, name, reputation_score, created_at FROM agents WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const now = new Date();
    const recent30 = new Date(now.getTime() - 30 * 24 * 3600000).toISOString();
    const older90 = new Date(now.getTime() - 90 * 24 * 3600000).toISOString();

    const [recentOrders, olderOrders, recentReviews, olderReviews] = await Promise.all([
      // Last 30 days
      dbGet(
        `SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed
         FROM orders WHERE seller_id = ${p(1)} AND created_at > ${p(2)}`,
        [agent.id, recent30]
      ),
      // 31-90 days ago
      dbGet(
        `SELECT COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed
         FROM orders WHERE seller_id = ${p(1)} AND created_at BETWEEN ${p(2)} AND ${p(3)}`,
        [agent.id, older90, recent30]
      ),
      // Recent reviews
      dbGet(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews
         WHERE seller_id = ${p(1)} AND created_at > ${p(2)}`,
        [agent.id, recent30]
      ),
      // Older reviews
      dbGet(
        `SELECT AVG(rating) as avg_rating FROM reviews
         WHERE seller_id = ${p(1)} AND created_at BETWEEN ${p(2)} AND ${p(3)}`,
        [agent.id, older90, recent30]
      ),
    ]);

    // Time-decay weighting: recent = 3x, older = 1x
    const recTotal = parseInt(recentOrders?.total) || 0;
    const recCompleted = parseInt(recentOrders?.completed) || 0;
    const recDisputed = parseInt(recentOrders?.disputed) || 0;
    const oldTotal = parseInt(olderOrders?.total) || 0;
    const oldCompleted = parseInt(olderOrders?.completed) || 0;
    const oldDisputed = parseInt(olderOrders?.disputed) || 0;

    const weightedTotal = recTotal * 3 + oldTotal;
    const weightedCompleted = recCompleted * 3 + oldCompleted;
    const weightedDisputed = recDisputed * 3 + oldDisputed;

    const completionRate = weightedTotal > 0 ? parseFloat((weightedCompleted / weightedTotal * 100).toFixed(1)) : null;
    const disputeRate = weightedTotal > 0 ? parseFloat((weightedDisputed / weightedTotal * 100).toFixed(1)) : null;

    // Rating score (weighted)
    const recRating = recentReviews?.avg_rating ? parseFloat(parseFloat(recentReviews.avg_rating).toFixed(2)) : null;
    const oldRating = olderReviews?.avg_rating ? parseFloat(parseFloat(olderReviews.avg_rating).toFixed(2)) : null;
    let weightedRating = null;
    if (recRating !== null && oldRating !== null) {
      weightedRating = parseFloat(((recRating * 3 + oldRating) / 4).toFixed(2));
    } else if (recRating !== null) {
      weightedRating = recRating;
    } else if (oldRating !== null) {
      weightedRating = oldRating;
    }

    // Composite reliability score (0-100)
    let reliability = 50; // baseline
    if (completionRate !== null) reliability = completionRate * 0.5;
    if (disputeRate !== null) reliability -= disputeRate * 0.3;
    if (weightedRating !== null) reliability += (weightedRating / 5) * 20;
    if (recTotal >= 3) reliability += 5; // bonus for recent activity
    reliability = Math.max(0, Math.min(100, parseFloat(reliability.toFixed(1))));

    const level = reliability >= 85 ? 'Excellent' : reliability >= 70 ? 'Good' : reliability >= 50 ? 'Average' : 'Poor';

    res.json({
      agent_id: agent.id,
      name: agent.name,
      reliability_score: reliability,
      reliability_level: level,
      methodology: 'time_decay_30d_3x_weight',
      factors: {
        weighted_completion_rate: completionRate,
        weighted_dispute_rate: disputeRate,
        weighted_avg_rating: weightedRating,
        recent_orders_30d: recTotal,
        older_orders_31_90d: oldTotal,
      },
      base_reputation_score: agent.reputation_score,
      generated_at: now.toISOString(),
    });
  } catch (err) { next(err); }
});

// DELETE /agents/me/blocklist/:targetId — remove an agent from the blocklist
router.delete('/me/blocklist/:targetId', requireApiKey, async (req, res, next) => {
  try {
    const agentRow = await dbGet(`SELECT blocklist FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    const blocklist = agentRow?.blocklist
      ? (typeof agentRow.blocklist === 'string' ? JSON.parse(agentRow.blocklist) : agentRow.blocklist)
      : [];

    const idx = blocklist.findIndex(b => b.agent_id === req.params.targetId);
    if (idx === -1) return res.status(404).json({ error: 'Agent not found on blocklist' });

    blocklist.splice(idx, 1);
    await dbRun(`UPDATE agents SET blocklist = ${p(1)} WHERE id = ${p(2)}`, [JSON.stringify(blocklist), req.agent.id]);
    res.json({ message: 'Agent removed from blocklist.', blocklist_count: blocklist.length });
  } catch (err) { next(err); }
});

module.exports = router;
