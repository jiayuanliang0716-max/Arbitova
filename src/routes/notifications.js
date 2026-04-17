'use strict';

const express = require('express');
const { dbAll } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();
const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

/**
 * GET /notifications
 * Returns recent activity that the agent should be aware of.
 * Aggregates: new orders (seller), new messages (unread), disputes, deliveries awaiting confirmation.
 * Query params: ?limit=20 (default 20, max 50)
 */
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const id = req.agent.id;
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const [
      newOrders,
      pendingDeliveries,
      disputes,
    ] = await Promise.all([
      dbAll(
        `SELECT o.id, o.amount, o.created_at, s.name as service_name, buyer.name as buyer_name
         FROM orders o
         LEFT JOIN services s ON o.service_id = s.id
         LEFT JOIN agents buyer ON o.buyer_id = buyer.id
         WHERE o.seller_id = ${p(1)} AND o.status = 'paid'
         ORDER BY o.created_at DESC LIMIT ${p(2)}`,
        [id, Math.ceil(limit / 3)]
      ),
      dbAll(
        `SELECT o.id, o.amount, o.created_at, s.name as service_name, seller.name as seller_name
         FROM orders o
         LEFT JOIN services s ON o.service_id = s.id
         LEFT JOIN agents seller ON o.seller_id = seller.id
         WHERE o.buyer_id = ${p(1)} AND o.status = 'delivered'
         ORDER BY o.created_at DESC LIMIT ${p(2)}`,
        [id, Math.ceil(limit / 3)]
      ),
      dbAll(
        `SELECT d.id, d.order_id, d.status, d.reason, d.created_at,
                o.amount, o.buyer_id, o.seller_id
         FROM disputes d
         LEFT JOIN orders o ON d.order_id = o.id
         WHERE (o.buyer_id = ${p(1)} OR o.seller_id = ${p(2)}) AND d.status = 'open'
         ORDER BY d.created_at DESC LIMIT ${p(3)}`,
        [id, id, Math.ceil(limit / 3)]
      ).catch(() => []),
    ]);

    const notifications = [];

    for (const o of newOrders) {
      notifications.push({
        type: 'new_order',
        priority: 'high',
        title: `New order: ${o.service_name || 'service'}`,
        body: `${o.buyer_name || 'A buyer'} placed an order for ${parseFloat(o.amount).toFixed(2)} USDC. Deliver to get paid.`,
        order_id: o.id,
        amount: parseFloat(o.amount),
        created_at: o.created_at,
      });
    }

    for (const o of pendingDeliveries) {
      notifications.push({
        type: 'delivery_received',
        priority: 'medium',
        title: `Delivery ready: ${o.service_name || 'order'}`,
        body: `${o.seller_name || 'Seller'} has delivered. Confirm to release payment or dispute.`,
        order_id: o.id,
        amount: parseFloat(o.amount),
        created_at: o.created_at,
      });
    }

    for (const d of disputes) {
      const isMyDispute = d.buyer_id === id ? 'you filed' : 'filed against you';
      notifications.push({
        type: 'dispute_active',
        priority: 'urgent',
        title: `Dispute active (${isMyDispute})`,
        body: d.reason ? d.reason.substring(0, 80) : 'A dispute is awaiting resolution.',
        order_id: d.order_id,
        dispute_id: d.id,
        amount: parseFloat(d.amount || 0),
        created_at: d.created_at,
      });
    }

    // Sort by created_at descending, take limit
    notifications.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const trimmed = notifications.slice(0, limit);

    res.json({
      count: trimmed.length,
      unread: trimmed.length,
      notifications: trimmed,
    });
  } catch (err) { next(err); }
});

module.exports = router;
