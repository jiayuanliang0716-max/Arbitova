const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const PLATFORM_FEE_RATE = 0.025;

function nextBillingDate(interval) {
  const d = new Date();
  if (interval === 'daily')   d.setDate(d.getDate() + 1);
  if (interval === 'weekly')  d.setDate(d.getDate() + 7);
  if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

// POST /subscriptions — subscribe to a service
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { service_id } = req.body || {};
    if (!service_id) return res.status(400).json({ error: 'service_id is required' });

    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)} AND ${activeCheck}`, [service_id]);
    if (!service) return res.status(404).json({ error: 'Service not found or inactive' });
    if (service.agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot subscribe to your own service' });

    const interval = service.sub_interval;
    const price = parseFloat(service.sub_price || 0);
    if (!interval || price <= 0) {
      return res.status(400).json({ error: 'This service does not offer a subscription plan' });
    }

    // Check for existing active subscription
    const existing = await dbGet(
      `SELECT id FROM subscriptions WHERE buyer_id = ${p(1)} AND service_id = ${p(2)} AND status = 'active'`,
      [req.agent.id, service_id]
    );
    if (existing) return res.status(400).json({ error: 'You already have an active subscription to this service' });

    // Charge first billing now
    const buyer = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(buyer.balance) < price) {
      return res.status(400).json({ error: 'Insufficient balance for first billing', balance: buyer.balance, required: price });
    }

    const fee = price * PLATFORM_FEE_RATE;
    const sellerReceives = price - fee;
    const subId = uuidv4();
    const nextBilling = nextBillingDate(interval);

    await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [price, req.agent.id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, service.agent_id]);
    await dbRun(
      `INSERT INTO subscriptions (id, buyer_id, seller_id, service_id, interval, price, status, next_billing_at)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},'active',${p(7)})`,
      [subId, req.agent.id, service.agent_id, service_id, interval, price, nextBilling]
    );

    res.status(201).json({
      id: subId,
      service_name: service.name,
      interval,
      price,
      platform_fee: fee.toFixed(4),
      seller_received: sellerReceives.toFixed(4),
      next_billing_at: nextBilling,
      status: 'active',
      message: `Subscribed. First billing charged. Next billing: ${nextBilling}`
    });
  } catch (err) { next(err); }
});

// GET /subscriptions — list my subscriptions (as buyer or seller)
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const { role } = req.query; // 'buyer' | 'seller' | undefined (both)
    let where = '';
    const params = [];
    if (role === 'buyer') {
      where = `WHERE sub.buyer_id = ${p(1)}`; params.push(req.agent.id);
    } else if (role === 'seller') {
      where = `WHERE sub.seller_id = ${p(1)}`; params.push(req.agent.id);
    } else {
      where = `WHERE (sub.buyer_id = ${p(1)} OR sub.seller_id = ${p(2)})`; params.push(req.agent.id, req.agent.id);
    }
    const subs = await dbAll(
      `SELECT sub.*, s.name as service_name, ab.name as buyer_name, as2.name as seller_name
       FROM subscriptions sub
       JOIN services s ON sub.service_id = s.id
       JOIN agents ab ON sub.buyer_id = ab.id
       JOIN agents as2 ON sub.seller_id = as2.id
       ${where}
       ORDER BY sub.created_at DESC`,
      params
    );
    res.json({ count: subs.length, subscriptions: subs });
  } catch (err) { next(err); }
});

// POST /subscriptions/:id/cancel — buyer cancels subscription
router.post('/:id/cancel', requireApiKey, async (req, res, next) => {
  try {
    const sub = await dbGet(`SELECT * FROM subscriptions WHERE id = ${p(1)}`, [req.params.id]);
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    if (sub.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the subscriber can cancel' });
    if (sub.status !== 'active') return res.status(400).json({ error: `Subscription is already ${sub.status}` });

    const now = isPostgres ? 'NOW()' : "datetime('now')";
    await dbRun(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = ${now} WHERE id = ${p(1)}`,
      [sub.id]
    );
    res.json({ id: sub.id, status: 'cancelled', message: 'Subscription cancelled. No further charges.' });
  } catch (err) { next(err); }
});

// POST /subscriptions/process-billing — charge all due subscriptions
// Admin only (X-Admin-Key header). In production this would be triggered by a cron job.
router.post('/process-billing', async (req, res, next) => {
  try {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey || req.headers['x-admin-key'] !== adminKey) {
      return res.status(401).json({ error: 'Invalid admin key' });
    }

    const now = new Date().toISOString();
    const due = await dbAll(
      `SELECT sub.*, s.name as service_name
       FROM subscriptions sub
       JOIN services s ON sub.service_id = s.id
       WHERE sub.status = 'active' AND sub.next_billing_at <= ${p(1)}`,
      [now]
    );

    const results = [];
    for (const sub of due) {
      const price = parseFloat(sub.price);
      const buyer = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [sub.buyer_id]);
      const balance = parseFloat(buyer?.balance || 0);

      if (balance < price) {
        // Insufficient funds — cancel subscription
        const cancelNow = isPostgres ? 'NOW()' : "datetime('now')";
        await dbRun(
          `UPDATE subscriptions SET status = 'cancelled', cancelled_at = ${cancelNow} WHERE id = ${p(1)}`,
          [sub.id]
        );
        results.push({ id: sub.id, service: sub.service_name, outcome: 'cancelled_insufficient_funds' });
        continue;
      }

      const fee = price * PLATFORM_FEE_RATE;
      const sellerReceives = price - fee;
      const nextBilling = nextBillingDate(sub.interval);

      await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [price, sub.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, sub.seller_id]);
      await dbRun(`UPDATE subscriptions SET next_billing_at = ${p(1)} WHERE id = ${p(2)}`, [nextBilling, sub.id]);

      results.push({ id: sub.id, service: sub.service_name, charged: price, next_billing_at: nextBilling, outcome: 'billed' });
    }

    res.json({ processed: results.length, results });
  } catch (err) { next(err); }
});

module.exports = router;
