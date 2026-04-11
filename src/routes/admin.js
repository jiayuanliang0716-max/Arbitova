/**
 * admin.js — Platform-wide analytics and management API
 *
 * All endpoints require the X-Admin-Key header matching process.env.ADMIN_KEY.
 *
 * Endpoints:
 *   GET /admin/dashboard  — Platform overview stats
 *   GET /admin/agents     — Paginated agent list
 *   GET /admin/orders     — Paginated order list
 *   GET /admin/payments   — Paginated LemonSqueezy payments list
 *   GET /admin/revenue    — Revenue breakdown
 */

const express = require('express');
const { dbGet, dbAll } = require('../db/helpers');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? '$' + n : '?';

// ---------------------------------------------------------------------------
// Admin authentication middleware
// ---------------------------------------------------------------------------
function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_KEY;
  const provided = req.headers['x-admin-key'];

  if (!provided) {
    return res.status(401).json({ error: 'Missing X-Admin-Key header' });
  }
  if (!adminKey || provided !== adminKey) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

// Apply admin auth to all routes in this router
router.use(requireAdminKey);

// ---------------------------------------------------------------------------
// Helper: parse pagination params with safe defaults
// ---------------------------------------------------------------------------
function parsePagination(query, defaultLimit = 20) {
  const page  = Math.max(1, parseInt(query.page,  10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ---------------------------------------------------------------------------
// Helper: date string N days ago (ISO 8601)
// ---------------------------------------------------------------------------
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// GET /admin/dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
  try {
    const sevenDaysAgo = daysAgo(7);

    // ── Totals ───────────────────────────────────────────────────────────────
    const [
      totalAgentsRow,
      totalServicesRow,
      ordersByStatus,
      revenueRow,
    ] = await Promise.all([
      dbAll('SELECT COUNT(*) AS count FROM agents', []),
      dbAll('SELECT COUNT(*) AS count FROM services', []),
      dbAll('SELECT status, COUNT(*) AS count FROM orders GROUP BY status', []),
      dbAll(
        `SELECT COALESCE(SUM(amount * 0.025), 0) AS total_fees FROM orders WHERE status = ${p(1)}`,
        ['completed']
      ),
    ]);

    // ── Last 7 days activity ──────────────────────────────────────────────────
    const [newAgentsRow, newOrdersRow, completedOrdersRow] = await Promise.all([
      dbAll(
        `SELECT COUNT(*) AS count FROM agents WHERE created_at >= ${p(1)}`,
        [sevenDaysAgo]
      ),
      dbAll(
        `SELECT COUNT(*) AS count FROM orders WHERE created_at >= ${p(1)}`,
        [sevenDaysAgo]
      ),
      dbAll(
        `SELECT COUNT(*) AS count FROM orders WHERE status = ${p(1)} AND completed_at >= ${p(2)}`,
        ['completed', sevenDaysAgo]
      ),
    ]);

    // ── Top 5 sellers by revenue (completed orders) ───────────────────────────
    const topSellers = await dbAll(
      `SELECT a.id, a.name,
              COUNT(o.id)        AS order_count,
              SUM(o.amount)      AS gross_revenue,
              SUM(o.amount * 0.975) AS net_revenue
       FROM orders o
       JOIN agents a ON a.id = o.seller_id
       WHERE o.status = ${p(1)}
       GROUP BY a.id, a.name
       ORDER BY gross_revenue DESC
       LIMIT 5`,
      ['completed']
    );

    // ── Top 5 services by order count ─────────────────────────────────────────
    const topServices = await dbAll(
      `SELECT s.id, s.name, a.name AS seller_name,
              COUNT(o.id) AS order_count
       FROM orders o
       JOIN services s ON s.id = o.service_id
       JOIN agents  a ON a.id = s.agent_id
       GROUP BY s.id, s.name, a.name
       ORDER BY order_count DESC
       LIMIT 5`,
      []
    );

    // ── Build orders-by-status map ────────────────────────────────────────────
    const ordersMap = {};
    let totalOrders = 0;
    for (const row of ordersByStatus) {
      ordersMap[row.status] = parseInt(row.count, 10);
      totalOrders += parseInt(row.count, 10);
    }

    res.json({
      totals: {
        agents:       parseInt(totalAgentsRow[0]?.count   || 0, 10),
        services:     parseInt(totalServicesRow[0]?.count || 0, 10),
        orders:       totalOrders,
        orders_by_status: ordersMap,
        platform_fees_earned: parseFloat(revenueRow[0]?.total_fees || 0),
      },
      last_7_days: {
        new_agents:        parseInt(newAgentsRow[0]?.count       || 0, 10),
        new_orders:        parseInt(newOrdersRow[0]?.count       || 0, 10),
        completed_orders:  parseInt(completedOrdersRow[0]?.count || 0, 10),
      },
      top_sellers:  topSellers.map(r => ({
        id:            r.id,
        name:          r.name,
        order_count:   parseInt(r.order_count,   10),
        gross_revenue: parseFloat(r.gross_revenue || 0),
        net_revenue:   parseFloat(r.net_revenue   || 0),
      })),
      top_services: topServices.map(r => ({
        id:          r.id,
        name:        r.name,
        seller_name: r.seller_name,
        order_count: parseInt(r.order_count, 10),
      })),
    });
  } catch (err) {
    console.error('[admin] dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/agents
// Query params: ?page=1&limit=20&sort=created_at
// ---------------------------------------------------------------------------
router.get('/agents', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);

    // Allowlist sortable columns to prevent SQL injection
    const allowedSorts = ['created_at', 'name', 'balance', 'reputation_score'];
    const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'created_at';

    const totalRow = await dbAll('SELECT COUNT(*) AS count FROM agents', []);
    const total = parseInt(totalRow[0]?.count || 0, 10);

    // Param index offset: limit=$1, offset=$2 for PG; ? ? for SQLite
    const agents = await dbAll(
      `SELECT
         a.id, a.name, a.description, a.owner_email,
         a.balance, a.escrow, a.reputation_score,
         a.wallet_address, a.created_at,
         (SELECT COUNT(*) FROM services  s WHERE s.agent_id = a.id) AS service_count,
         (SELECT COUNT(*) FROM orders    o WHERE o.seller_id = a.id
                                             OR  o.buyer_id  = a.id) AS order_count
       FROM agents a
       ORDER BY a.${sort} DESC
       LIMIT ${p(1)} OFFSET ${p(2)}`,
      [limit, offset]
    );

    res.json({
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      agents: agents.map(a => ({
        id:               a.id,
        name:             a.name,
        description:      a.description,
        owner_email:      a.owner_email,
        balance:          parseFloat(a.balance   || 0),
        escrow:           parseFloat(a.escrow    || 0),
        reputation_score: parseFloat(a.reputation_score || 0),
        wallet_address:   a.wallet_address,
        service_count:    parseInt(a.service_count || 0, 10),
        order_count:      parseInt(a.order_count   || 0, 10),
        created_at:       a.created_at,
      })),
    });
  } catch (err) {
    console.error('[admin] agents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/orders
// Query params: ?page=1&limit=20&status=paid
// ---------------------------------------------------------------------------
router.get('/orders', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { status } = req.query;

    // Build optional status filter
    let whereClause = '';
    let params = [];
    let paramIdx = 1;

    if (status) {
      whereClause = `WHERE o.status = ${p(paramIdx++)}`;
      params.push(status);
    }

    // Count total matching rows
    const countSql = `SELECT COUNT(*) AS count FROM orders o ${whereClause}`;
    const totalRow = await dbAll(countSql, params);
    const total = parseInt(totalRow[0]?.count || 0, 10);

    // Fetch page
    const orders = await dbAll(
      `SELECT
         o.id, o.status, o.amount, o.requirements,
         o.created_at, o.completed_at, o.deadline,
         buyer.name  AS buyer_name,
         seller.name AS seller_name,
         s.name      AS service_name
       FROM orders o
       JOIN agents  buyer  ON buyer.id  = o.buyer_id
       JOIN agents  seller ON seller.id = o.seller_id
       JOIN services s     ON s.id      = o.service_id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT ${p(paramIdx++)} OFFSET ${p(paramIdx++)}`,
      [...params, limit, offset]
    );

    res.json({
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      orders: orders.map(o => ({
        id:           o.id,
        status:       o.status,
        amount:       parseFloat(o.amount || 0),
        buyer_name:   o.buyer_name,
        seller_name:  o.seller_name,
        service_name: o.service_name,
        requirements: o.requirements,
        deadline:     o.deadline,
        completed_at: o.completed_at,
        created_at:   o.created_at,
      })),
    });
  } catch (err) {
    console.error('[admin] orders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/payments
// Query params: ?page=1&limit=20&status=completed
// ---------------------------------------------------------------------------
router.get('/payments', async (req, res) => {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { status } = req.query;

    let whereClause = '';
    let params = [];
    let paramIdx = 1;

    if (status) {
      whereClause = `WHERE pay.status = ${p(paramIdx++)}`;
      params.push(status);
    }

    const countSql = `SELECT COUNT(*) AS count FROM payments pay ${whereClause}`;
    const totalRow = await dbAll(countSql, params);
    const total = parseInt(totalRow[0]?.count || 0, 10);

    const payments = await dbAll(
      `SELECT
         pay.id, pay.status, pay.amount_cents,
         pay.provider, pay.provider_order_id, pay.provider_checkout_id,
         pay.created_at,
         a.name  AS agent_name,
         s.name  AS service_name
       FROM payments pay
       JOIN agents   a ON a.id = pay.agent_id
       LEFT JOIN services s ON s.id = pay.service_id
       ${whereClause}
       ORDER BY pay.created_at DESC
       LIMIT ${p(paramIdx++)} OFFSET ${p(paramIdx++)}`,
      [...params, limit, offset]
    );

    res.json({
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
      payments: payments.map(pay => ({
        id:                   pay.id,
        status:               pay.status,
        amount_cents:         parseInt(pay.amount_cents || 0, 10),
        amount_usd:           parseFloat((pay.amount_cents || 0) / 100),
        provider:             pay.provider,
        provider_order_id:    pay.provider_order_id,
        provider_checkout_id: pay.provider_checkout_id,
        agent_name:           pay.agent_name,
        service_name:         pay.service_name,
        created_at:           pay.created_at,
      })),
    });
  } catch (err) {
    console.error('[admin] payments error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/revenue
// ---------------------------------------------------------------------------
router.get('/revenue', async (req, res) => {
  try {
    const thirtyDaysAgo = daysAgo(30);

    // ── Total platform fees (2.5% of completed orders) ───────────────────────
    const platformFeesRow = await dbAll(
      `SELECT COALESCE(SUM(amount * 0.025), 0) AS total_fees,
              COALESCE(SUM(amount), 0)          AS total_gmv,
              COUNT(*)                           AS completed_count
       FROM orders
       WHERE status = ${p(1)}`,
      ['completed']
    );

    // ── Revenue by day for last 30 days ───────────────────────────────────────
    // SQLite: strftime; PostgreSQL: DATE_TRUNC / TO_CHAR
    let revenueByDay;
    if (isPostgres) {
      revenueByDay = await dbAll(
        `SELECT TO_CHAR(DATE_TRUNC('day', completed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                COUNT(*)                           AS order_count,
                COALESCE(SUM(amount), 0)           AS gmv,
                COALESCE(SUM(amount * 0.025), 0)   AS platform_fees
         FROM orders
         WHERE status = $1
           AND completed_at >= $2
         GROUP BY DATE_TRUNC('day', completed_at AT TIME ZONE 'UTC')
         ORDER BY day ASC`,
        ['completed', thirtyDaysAgo]
      );
    } else {
      revenueByDay = await dbAll(
        `SELECT strftime('%Y-%m-%d', completed_at) AS day,
                COUNT(*)                            AS order_count,
                COALESCE(SUM(amount), 0)            AS gmv,
                COALESCE(SUM(amount * 0.025), 0)    AS platform_fees
         FROM orders
         WHERE status = ?
           AND completed_at >= ?
         GROUP BY strftime('%Y-%m-%d', completed_at)
         ORDER BY day ASC`,
        ['completed', thirtyDaysAgo]
      );
    }

    // ── Total LemonSqueezy payments received ──────────────────────────────────
    const lsPaymentsRow = await dbAll(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_cents,
              COUNT(*)                        AS payment_count
       FROM payments
       WHERE status = ${p(1)} AND provider = ${p(2)}`,
      ['completed', 'lemonsqueezy']
    );

    res.json({
      platform_fees: {
        total_fees_earned:   parseFloat(platformFeesRow[0]?.total_fees || 0),
        total_gmv:           parseFloat(platformFeesRow[0]?.total_gmv  || 0),
        completed_orders:    parseInt(platformFeesRow[0]?.completed_count || 0, 10),
        fee_rate:            0.025,
      },
      revenue_by_day: revenueByDay.map(r => ({
        day:           r.day,
        order_count:   parseInt(r.order_count   || 0, 10),
        gmv:           parseFloat(r.gmv         || 0),
        platform_fees: parseFloat(r.platform_fees || 0),
      })),
      lemonsqueezy_payments: {
        total_received_cents: parseInt(lsPaymentsRow[0]?.total_cents   || 0, 10),
        total_received_usd:   parseFloat((lsPaymentsRow[0]?.total_cents || 0) / 100),
        payment_count:        parseInt(lsPaymentsRow[0]?.payment_count || 0, 10),
      },
    });
  } catch (err) {
    console.error('[admin] revenue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/review-queue ────────────────────────────────────────────────
// List disputes escalated to human review (confidence too low after N=3 AI vote).
router.get('/review-queue', async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const rows = await dbAll(
      `SELECT q.*, o.amount, o.buyer_id, o.seller_id
       FROM human_review_queue q
       JOIN orders o ON o.id = q.order_id
       WHERE q.status = ${p(1)}
       ORDER BY q.created_at ASC`,
      [status]
    );
    res.json({ items: rows, count: rows.length, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/review-queue/:id/resolve ──────────────────────────────────
// Human reviewer submits their verdict.
// Body: { winner: 'buyer'|'seller', resolution: '...' }
router.post('/review-queue/:id/resolve', async (req, res) => {
  try {
    const { winner, resolution } = req.body;
    if (!['buyer', 'seller'].includes(winner)) {
      return res.status(400).json({ error: 'winner must be buyer or seller' });
    }
    if (!resolution) {
      return res.status(400).json({ error: 'resolution text is required' });
    }

    const item = await dbGet(
      `SELECT * FROM human_review_queue WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Review item not found' });
    if (item.status !== 'pending') return res.status(400).json({ error: 'Already resolved' });

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [item.order_id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { dbRun } = require('../db/helpers');
    const PLATFORM_FEE_RATE = 0.025;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    if (winner === 'buyer') {
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    } else {
      const fee = parseFloat(order.amount) * PLATFORM_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    }

    await dbRun(
      `UPDATE disputes SET status = 'resolved', resolution = ${p(1)}, resolved_at = ${now} WHERE id = ${p(2)}`,
      [`[Human Review] ${resolution}`, item.dispute_id]
    );
    await dbRun(
      `UPDATE human_review_queue SET status = 'resolved', resolution = ${p(1)}, resolved_at = ${now} WHERE id = ${p(2)}`,
      [resolution, item.id]
    );

    res.json({ ok: true, winner, order_id: order.id, new_status: winner === 'buyer' ? 'refunded' : 'completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
