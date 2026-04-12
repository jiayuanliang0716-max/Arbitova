'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const VALID_EVENTS = [
  'order.created', 'order.delivered', 'order.completed',
  'order.refunded', 'order.disputed', 'order.cancelled',
  'order.tip_received', 'order.deadline_extended',
  'dispute.resolved', 'dispute.appealed',
  'verification.passed', 'verification.failed',
  'message.received',
  'request.application_received', 'request.accepted',
  '*',
];

// ── POST /api/v1/webhooks ─────────────────────────────────────────────────────
// Register a new webhook endpoint.
// Returns the signing secret once — store it, it won't be shown again.
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { url, events } = req.body;

    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events must be a non-empty array' });
    }

    try { new URL(url); } catch {
      return res.status(400).json({ error: 'url must be a valid HTTPS URL' });
    }

    const invalid = events.filter(e => !VALID_EVENTS.includes(e));
    if (invalid.length) {
      return res.status(400).json({
        error: `Invalid event types: ${invalid.join(', ')}`,
        valid_events: VALID_EVENTS,
      });
    }

    const id     = uuidv4();
    const secret = crypto.randomBytes(32).toString('hex');

    await dbRun(
      `INSERT INTO webhooks (id, agent_id, url, events, secret)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
      [id, req.agent.id, url, JSON.stringify(events), secret]
    );

    res.status(201).json({
      id,
      url,
      events,
      secret, // shown only once — developer must save this
      is_active: true,
      created_at: new Date().toISOString(),
      _note: 'Save the secret — it will not be shown again. Use it to verify X-Arbitova-Signature.',
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/webhooks ──────────────────────────────────────────────────────
// List all webhooks for the authenticated agent.
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT id, url, events, is_active, created_at, last_triggered_at
       FROM webhooks WHERE agent_id = ${p(1)} ORDER BY created_at DESC`,
      [req.agent.id]
    );

    const webhooks = rows.map(wh => ({
      ...wh,
      events: typeof wh.events === 'string' ? JSON.parse(wh.events) : wh.events,
      is_active: !!wh.is_active,
    }));

    res.json({ webhooks, count: webhooks.length });
  } catch (err) { next(err); }
});

// ── DELETE /api/v1/webhooks/:id ───────────────────────────────────────────────
// Remove a webhook.
router.delete('/:id', requireApiKey, async (req, res, next) => {
  try {
    const wh = await dbGet(
      `SELECT id FROM webhooks WHERE id = ${p(1)} AND agent_id = ${p(2)}`,
      [req.params.id, req.agent.id]
    );

    if (!wh) return res.status(404).json({ error: 'Webhook not found' });

    await dbRun(`DELETE FROM webhooks WHERE id = ${p(1)}`, [req.params.id]);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ── POST /api/v1/webhooks/:id/test ───────────────────────────────────────────
// Fire a synthetic test event to a webhook URL and return the HTTP response.
router.post('/:id/test', requireApiKey, async (req, res, next) => {
  try {
    const wh = await dbGet(
      `SELECT id, url, secret FROM webhooks WHERE id = ${p(1)} AND agent_id = ${p(2)}`,
      [req.params.id, req.agent.id]
    );
    if (!wh) return res.status(404).json({ error: 'Webhook not found' });

    const payload = {
      event: 'test.ping',
      webhook_id: wh.id,
      agent_id: req.agent.id,
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test event from Arbitova.' },
    };

    const body = JSON.stringify(payload);
    const sig  = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');

    const start = Date.now();
    let status_code = null;
    let error = null;
    try {
      const resp = await fetch(wh.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Arbitova-Signature': `sha256=${sig}`,
          'X-Arbitova-Event': 'test.ping',
        },
        body,
        signal: AbortSignal.timeout(10000),
      });
      status_code = resp.status;
    } catch (e) {
      error = e.message;
    }
    const duration_ms = Date.now() - start;

    res.json({
      webhook_id: wh.id,
      url: wh.url,
      event: 'test.ping',
      status_code,
      duration_ms,
      success: status_code >= 200 && status_code < 300,
      error: error || null,
      payload,
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/webhooks/:id/deliveries ──────────────────────────────────────
// View delivery history for a specific webhook (for debugging).
router.get('/:id/deliveries', requireApiKey, async (req, res, next) => {
  try {
    const wh = await dbGet(
      `SELECT id FROM webhooks WHERE id = ${p(1)} AND agent_id = ${p(2)}`,
      [req.params.id, req.agent.id]
    );

    if (!wh) return res.status(404).json({ error: 'Webhook not found' });

    const deliveries = await dbAll(
      `SELECT id, event_type, response_code, attempts, status, created_at, delivered_at
       FROM webhook_deliveries WHERE webhook_id = ${p(1)}
       ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );

    res.json({ deliveries, count: deliveries.length });
  } catch (err) { next(err); }
});

// POST /api/v1/webhooks/deliveries/:delivery_id/redeliver
// Retry a specific failed delivery immediately (owner only).
router.post('/deliveries/:deliveryId/redeliver', requireApiKey, async (req, res, next) => {
  try {
    const delivery = await dbGet(
      `SELECT wd.*, wh.url, wh.secret, wh.agent_id, wh.events
       FROM webhook_deliveries wd
       JOIN webhooks wh ON wh.id = wd.webhook_id
       WHERE wd.id = ${p(1)}`,
      [req.params.deliveryId]
    );

    if (!delivery) return res.status(404).json({ error: 'Delivery not found' });
    if (delivery.agent_id !== req.agent.id) return res.status(403).json({ error: 'Access denied' });
    if (delivery.status === 'delivered') {
      return res.status(400).json({ error: 'Delivery already succeeded — no need to retry', delivery_id: delivery.id });
    }

    const { sign } = require('../webhooks');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let redeliveryStatus = 0;
    let ok = false;
    try {
      const res2 = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Arbitova-Signature': sign(delivery.payload, delivery.secret),
          'X-Arbitova-Event':     delivery.event_type,
          'X-Arbitova-Delivery':  delivery.id,
          'X-Arbitova-Redelivery': 'true',
        },
        body: delivery.payload,
        signal: controller.signal,
      });
      clearTimeout(timer);
      redeliveryStatus = res2.status;
      ok = res2.ok;
    } catch (_) {
      clearTimeout(timer);
    }

    const now = isPostgres ? 'NOW()' : "datetime('now')";
    if (ok) {
      await dbRun(
        `UPDATE webhook_deliveries SET status = 'delivered', response_code = ${p(1)}, attempts = attempts + 1, delivered_at = ${now} WHERE id = ${p(2)}`,
        [redeliveryStatus, delivery.id]
      ).catch(() => {});
    } else {
      await dbRun(
        `UPDATE webhook_deliveries SET attempts = attempts + 1, response_code = ${p(1)} WHERE id = ${p(2)}`,
        [redeliveryStatus, delivery.id]
      ).catch(() => {});
    }

    res.json({
      delivery_id: delivery.id,
      webhook_id: delivery.webhook_id,
      event_type: delivery.event_type,
      url: delivery.url,
      redelivery_ok: ok,
      response_code: redeliveryStatus,
      message: ok ? 'Redelivery succeeded.' : `Redelivery failed (HTTP ${redeliveryStatus || 'timeout'}).`,
    });
  } catch (err) { next(err); }
});

module.exports = router;
