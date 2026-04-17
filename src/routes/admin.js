/**
 * admin.js — Platform-wide analytics and management API
 *
 * All endpoints require the X-Admin-Key header matching process.env.ADMIN_KEY.
 *
 * Endpoints:
 *   GET /admin/dashboard  — Platform overview stats
 *   GET /admin/agents     — Paginated agent list
 *   GET /admin/orders     — Paginated order list
 *   GET /admin/revenue    — Revenue breakdown
 */

const express = require('express');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { getPlatformWalletAddress, transferFromPlatform, isChainMode } = require('../wallet');
const { SETTLEMENT_FEE_RATE, DISPUTE_FEE_RATE, creditPlatformFee } = require('../config/fees');

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
        `SELECT COALESCE(SUM(amount * ${SETTLEMENT_FEE_RATE}), 0) AS total_fees FROM orders WHERE status = ${p(1)}`,
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
// GET /admin/revenue
// ---------------------------------------------------------------------------
router.get('/revenue', async (req, res) => {
  try {
    const thirtyDaysAgo = daysAgo(30);

    // ── Total platform fees (0.5% of completed orders) ───────────────────────
    const platformFeesRow = await dbAll(
      `SELECT COALESCE(SUM(amount * ${SETTLEMENT_FEE_RATE}), 0) AS total_fees,
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
                COALESCE(SUM(amount * ${SETTLEMENT_FEE_RATE}), 0)   AS platform_fees
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
                COALESCE(SUM(amount * ${SETTLEMENT_FEE_RATE}), 0)    AS platform_fees
         FROM orders
         WHERE status = ?
           AND completed_at >= ?
         GROUP BY strftime('%Y-%m-%d', completed_at)
         ORDER BY day ASC`,
        ['completed', thirtyDaysAgo]
      );
    }

    res.json({
      platform_fees: {
        total_fees_earned:   parseFloat(platformFeesRow[0]?.total_fees || 0),
        total_gmv:           parseFloat(platformFeesRow[0]?.total_gmv  || 0),
        completed_orders:    parseInt(platformFeesRow[0]?.completed_count || 0, 10),
        fee_rate:            SETTLEMENT_FEE_RATE,
      },
      revenue_by_day: revenueByDay.map(r => ({
        day:           r.day,
        order_count:   parseInt(r.order_count   || 0, 10),
        gmv:           parseFloat(r.gmv         || 0),
        platform_fees: parseFloat(r.platform_fees || 0),
      })),
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
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    if (winner === 'buyer') {
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    } else {
      const fee = parseFloat(order.amount) * DISPUTE_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      await creditPlatformFee(fee);
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

// ── GET /admin/payout-status — show accumulated platform revenue ──────────────
router.get('/payout-status', async (req, res) => {
  try {
    const row = await dbGet(`SELECT * FROM platform_revenue WHERE id = 'singleton'`, []);
    const platformAddress = getPlatformWalletAddress();
    res.json({
      platform_wallet: platformAddress,
      balance: parseFloat(row?.balance || 0),
      total_earned: parseFloat(row?.total_earned || 0),
      total_withdrawn: parseFloat(row?.total_withdrawn || 0),
      chain_mode: isChainMode(),
      note: isChainMode()
        ? 'Use POST /admin/payout to withdraw USDC to your wallet.'
        : 'Mock mode: no real USDC. Enable ALCHEMY_API_KEY + CHAIN=base for real payouts.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/payout — withdraw platform revenue to owner wallet ────────────
router.post('/payout', async (req, res) => {
  try {
    const { amount } = req.body || {};
    const to_address = (req.body || {}).to_address || process.env.OWNER_WALLET_ADDRESS;
    if (!to_address || !/^0x[0-9a-fA-F]{40}$/.test(to_address)) {
      return res.status(400).json({ error: 'Valid to_address required (or set OWNER_WALLET_ADDRESS env var)' });
    }

    const row = await dbGet(`SELECT * FROM platform_revenue WHERE id = 'singleton'`, []);
    const available = parseFloat(row?.balance || 0);
    const requested = amount ? parseFloat(amount) : available;

    if (requested <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });
    if (requested > available) {
      return res.status(400).json({ error: 'Insufficient platform balance', available, requested });
    }

    if (!isChainMode()) {
      // Mock mode: just deduct from DB, no real transfer
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(
        `UPDATE platform_revenue SET balance = balance - ${p(1)}, total_withdrawn = total_withdrawn + ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
        [requested, requested]
      );
      return res.json({
        success: true,
        mode: 'mock',
        withdrawn: requested,
        to_address,
        remaining_balance: available - requested,
        note: 'Mock mode: no real USDC transferred. Enable chain mode for real payouts.',
      });
    }

    // Chain mode: real USDC transfer from platform wallet
    const now = isPostgres ? 'NOW()' : "datetime('now')";
    await dbRun(
      `UPDATE platform_revenue SET balance = balance - ${p(1)}, total_withdrawn = total_withdrawn + ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
      [requested, requested]
    );

    try {
      const result = await transferFromPlatform(to_address, requested);
      res.json({
        success: true,
        mode: 'chain',
        withdrawn: requested,
        to_address,
        tx_hash: result.txHash,
        block: result.blockNumber,
        remaining_balance: available - requested,
      });
    } catch (chainErr) {
      // Rollback DB on chain failure
      await dbRun(
        `UPDATE platform_revenue SET balance = balance + ${p(1)}, total_withdrawn = total_withdrawn - ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
        [requested, requested]
      );
      res.status(500).json({ error: 'On-chain transfer failed', details: chainErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Site Config (CMS) ──────────────────────────────────────────────────────

// GET /admin/site-config — get all config values
router.get('/site-config', requireAdminKey, async (req, res) => {
  try {
    const rows = await dbAll('SELECT key, value FROM site_config ORDER BY key');
    const config = {};
    for (const r of rows) {
      config[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    }
    res.json({ config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/site-config — set one or more config values
router.put('/site-config', requireAdminKey, async (req, res) => {
  try {
    const updates = req.body; // { key: value, ... }
    if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'Body must be a JSON object' });
    for (const [key, value] of Object.entries(updates)) {
      const jsonVal = JSON.stringify(value);
      await dbRun(
        `INSERT INTO site_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, jsonVal]
      );
    }
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Announcements ──────────────────────────────────────────────────────────

// GET /admin/announcements — list all announcements
router.get('/announcements', requireAdminKey, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM announcements ORDER BY created_at DESC');
    res.json({ announcements: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/announcements — create and publish announcement
router.post('/announcements', requireAdminKey, async (req, res) => {
  try {
    const { text, url, active = true } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const id = require('crypto').randomUUID();
    await dbRun(
      `INSERT INTO announcements (id, text, url, active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [id, text, url || null, active]
    );

    // Sync to Discord if webhook configured
    if (active && process.env.DISCORD_WEBHOOK_URL) {
      const discordBody = {
        content: `**Arbitova Update:** ${text}${url ? '\n' + url : ''}`
      };
      fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordBody)
      }).catch(e => console.error('Discord webhook error:', e.message));
    }

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /admin/announcements/:id — toggle active status
router.patch('/announcements/:id', requireAdminKey, async (req, res) => {
  try {
    const { active } = req.body;
    await dbRun(
      'UPDATE announcements SET active = $1, updated_at = NOW() WHERE id = $2',
      [active, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/announcements/:id
router.delete('/announcements/:id', requireAdminKey, async (req, res) => {
  try {
    await dbRun('DELETE FROM announcements WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
