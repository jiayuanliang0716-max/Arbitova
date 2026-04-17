'use strict';

const { fire, EVENTS } = require('../webhooks');

/**
 * Request/RFP Board — reverse marketplace
 *
 * Buyers post task requests with a budget; sellers apply with their service.
 * Buyer accepts one application → escrow created automatically.
 *
 * Flow:
 *   POST /requests              — buyer creates request
 *   GET  /requests              — public board (sellers browse)
 *   GET  /requests/:id          — request detail
 *   POST /requests/:id/apply    — seller applies (links a service + optional custom price)
 *   GET  /requests/:id/applications — buyer views applications
 *   POST /requests/:id/accept   — buyer accepts an application → auto-creates escrow
 *   POST /requests/:id/close    — buyer closes without accepting (refunds nothing, just marks closed)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// ── POST /requests — buyer posts a task request ────────────────────────────────
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { title, description, budget_usdc, category, delivery_hours, expires_in_hours } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!description) return res.status(400).json({ error: 'description is required' });
    if (!budget_usdc || parseFloat(budget_usdc) < 0.01) {
      return res.status(400).json({ error: 'budget_usdc must be at least 0.01' });
    }

    const id = uuidv4();
    const expiresHours = Math.min(parseInt(expires_in_hours) || 72, 720); // max 30 days
    const expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000).toISOString();

    await dbRun(
      `INSERT INTO requests (id, buyer_id, title, description, budget_usdc, category, delivery_hours, expires_at, status)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},'open')`,
      [id, req.agent.id, title, description, parseFloat(budget_usdc),
       category || null, parseInt(delivery_hours) || null, expiresAt]
    );

    const created = await dbGet(`SELECT * FROM requests WHERE id = ${p(1)}`, [id]);
    res.status(201).json({
      ...created,
      budget_usdc: parseFloat(created.budget_usdc),
      message: 'Request posted. Sellers can now apply.',
    });
  } catch (err) { next(err); }
});

// ── GET /requests — public board ───────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { category, q, status = 'open' } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);

    const conditions = [`r.status = ${p(1)}`];
    const params = [status];
    let idx = 2;

    // Auto-expire: mark requests past expires_at as expired
    const now = new Date().toISOString();
    await dbRun(
      `UPDATE requests SET status = 'expired' WHERE status = 'open' AND expires_at < ${p(1)}`,
      [now]
    ).catch(() => {});

    if (category) {
      conditions.push(`r.category = ${p(idx++)}`);
      params.push(category);
    }
    if (q) {
      conditions.push(`(r.title LIKE ${p(idx)} OR r.description LIKE ${p(idx + 1)})`);
      params.push(`%${q}%`, `%${q}%`);
      idx += 2;
    }

    const requests = await dbAll(
      `SELECT r.*, a.name as buyer_name,
              (SELECT COUNT(*) FROM request_applications ra WHERE ra.request_id = r.id) as application_count
       FROM requests r
       JOIN agents a ON r.buyer_id = a.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.created_at DESC
       LIMIT ${p(idx)}`,
      [...params, limit]
    );

    res.json({
      count: requests.length,
      filters: { status, category: category || null, q: q || null },
      requests: requests.map(r => ({
        ...r,
        budget_usdc: parseFloat(r.budget_usdc || 0),
        application_count: parseInt(r.application_count || 0),
      })),
    });
  } catch (err) { next(err); }
});

// ── GET /requests/:id — request detail ────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const request = await dbGet(
      `SELECT r.*, a.name as buyer_name, a.id as buyer_id
       FROM requests r JOIN agents a ON r.buyer_id = a.id
       WHERE r.id = ${p(1)}`,
      [req.params.id]
    );
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const appCount = await dbGet(
      `SELECT COUNT(*) as cnt FROM request_applications WHERE request_id = ${p(1)}`,
      [req.params.id]
    );

    res.json({
      ...request,
      budget_usdc: parseFloat(request.budget_usdc || 0),
      application_count: parseInt(appCount?.cnt || 0),
    });
  } catch (err) { next(err); }
});

// ── POST /requests/:id/apply — seller applies ──────────────────────────────────
router.post('/:id/apply', requireApiKey, async (req, res, next) => {
  try {
    const request = await dbGet(`SELECT * FROM requests WHERE id = ${p(1)}`, [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'open') return res.status(400).json({ error: `Request is ${request.status}` });
    if (request.buyer_id === req.agent.id) return res.status(400).json({ error: 'Cannot apply to your own request' });

    const { service_id, proposed_price, message } = req.body;
    if (!service_id) return res.status(400).json({ error: 'service_id is required' });

    // Verify service belongs to seller and is active
    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const service = await dbGet(
      `SELECT * FROM services WHERE id = ${p(1)} AND agent_id = ${p(2)} AND ${activeCheck}`,
      [service_id, req.agent.id]
    );
    if (!service) return res.status(404).json({ error: 'Service not found, inactive, or not owned by you' });

    // Check for duplicate application
    const existing = await dbGet(
      `SELECT id FROM request_applications WHERE request_id = ${p(1)} AND seller_id = ${p(2)}`,
      [request.id, req.agent.id]
    );
    if (existing) return res.status(409).json({ error: 'You have already applied to this request' });

    const price = proposed_price ? parseFloat(proposed_price) : parseFloat(service.price);
    if (price < 0.01) return res.status(400).json({ error: 'proposed_price must be at least 0.01' });

    const appId = uuidv4();
    await dbRun(
      `INSERT INTO request_applications (id, request_id, seller_id, service_id, proposed_price, message, status)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},'pending')`,
      [appId, request.id, req.agent.id, service_id, price, message || null]
    );

    fire([request.buyer_id], EVENTS.REQUEST_APPLICATION_RECEIVED, {
      request_id: request.id,
      application_id: appId,
      seller_id: req.agent.id,
      proposed_price: price,
    }).catch(() => {});

    res.status(201).json({
      application_id: appId,
      request_id: request.id,
      service_id,
      service_name: service.name,
      proposed_price: price,
      message: message || null,
      status: 'pending',
    });
  } catch (err) { next(err); }
});

// ── GET /requests/:id/applications — buyer views applications ──────────────────
router.get('/:id/applications', requireApiKey, async (req, res, next) => {
  try {
    const request = await dbGet(`SELECT * FROM requests WHERE id = ${p(1)}`, [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.buyer_id !== req.agent.id) {
      return res.status(403).json({ error: 'Only the buyer can view applications' });
    }

    const applications = await dbAll(
      `SELECT ra.*, a.name as seller_name, a.id as seller_id,
              COALESCE(a.reputation_score, 0) as seller_reputation,
              s.name as service_name, s.description as service_description,
              s.delivery_hours,
              (SELECT COUNT(*) FROM orders o WHERE o.seller_id = ra.seller_id AND o.status = 'completed') as completed_sales
       FROM request_applications ra
       JOIN agents a ON ra.seller_id = a.id
       JOIN services s ON ra.service_id = s.id
       WHERE ra.request_id = ${p(1)}
       ORDER BY ra.created_at ASC`,
      [request.id]
    );

    res.json({
      request_id: request.id,
      request_title: request.title,
      count: applications.length,
      applications: applications.map(a => ({
        ...a,
        proposed_price: parseFloat(a.proposed_price || 0),
        seller_reputation: parseInt(a.seller_reputation || 0),
        completed_sales: parseInt(a.completed_sales || 0),
      })),
    });
  } catch (err) { next(err); }
});

// ── POST /requests/:id/accept — buyer accepts an application, auto-creates escrow ──
router.post('/:id/accept', requireApiKey, async (req, res, next) => {
  try {
    const { application_id } = req.body;
    if (!application_id) return res.status(400).json({ error: 'application_id is required' });

    const request = await dbGet(`SELECT * FROM requests WHERE id = ${p(1)}`, [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can accept' });
    if (request.status !== 'open') return res.status(400).json({ error: `Request is ${request.status}` });

    const app = await dbGet(
      `SELECT * FROM request_applications WHERE id = ${p(1)} AND request_id = ${p(2)}`,
      [application_id, request.id]
    );
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.status !== 'pending') return res.status(400).json({ error: `Application is ${app.status}` });

    // Verify buyer has sufficient balance
    const buyer = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(buyer.balance) < parseFloat(app.proposed_price)) {
      return res.status(400).json({
        error: 'Insufficient balance',
        balance: buyer.balance,
        required: app.proposed_price,
      });
    }

    // Create escrow order
    const orderId = uuidv4();
    const deliveryHours = parseInt(request.delivery_hours) || 24;
    const deadline = new Date(Date.now() + deliveryHours * 3600 * 1000).toISOString();
    const price = parseFloat(app.proposed_price);

    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
      [price, price, req.agent.id]
    );
    await dbRun(
      `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)})`,
      [orderId, req.agent.id, app.seller_id, app.service_id, price,
       JSON.stringify({ request_id: request.id, request_title: request.title, request_description: request.description }),
       deadline]
    );

    // Mark request as accepted, reject other applications
    await dbRun(`UPDATE requests SET status = 'accepted', accepted_order_id = ${p(1)} WHERE id = ${p(2)}`, [orderId, request.id]);
    await dbRun(`UPDATE request_applications SET status = 'accepted' WHERE id = ${p(1)}`, [application_id]);
    await dbRun(
      `UPDATE request_applications SET status = 'rejected' WHERE request_id = ${p(1)} AND id != ${p(2)}`,
      [request.id, application_id]
    );

    fire([app.seller_id], EVENTS.REQUEST_ACCEPTED, {
      request_id: request.id,
      order_id: orderId,
      buyer_id: req.agent.id,
      amount: price,
    }).catch(() => {});

    res.json({
      order_id: orderId,
      request_id: request.id,
      application_id,
      seller_id: app.seller_id,
      amount: price,
      deadline,
      status: 'paid',
      message: `Application accepted. Escrow created. Order ID: ${orderId}.`,
    });
  } catch (err) { next(err); }
});

// ── POST /requests/:id/close — buyer closes request without accepting ──────────
router.post('/:id/close', requireApiKey, async (req, res, next) => {
  try {
    const request = await dbGet(`SELECT * FROM requests WHERE id = ${p(1)}`, [req.params.id]);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can close this request' });
    if (!['open'].includes(request.status)) return res.status(400).json({ error: `Request is already ${request.status}` });

    await dbRun(`UPDATE requests SET status = 'closed' WHERE id = ${p(1)}`, [request.id]);
    await dbRun(
      `UPDATE request_applications SET status = 'rejected' WHERE request_id = ${p(1)} AND status = 'pending'`,
      [request.id]
    );

    res.json({ request_id: request.id, status: 'closed', message: 'Request closed.' });
  } catch (err) { next(err); }
});

// ── GET /requests/mine — buyer sees their own requests ─────────────────────────
router.get('/mine', requireApiKey, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const requests = await dbAll(
      `SELECT r.*,
              (SELECT COUNT(*) FROM request_applications ra WHERE ra.request_id = r.id) as application_count
       FROM requests r
       WHERE r.buyer_id = ${p(1)}
       ORDER BY r.created_at DESC LIMIT ${p(2)}`,
      [req.agent.id, limit]
    );
    res.json({
      count: requests.length,
      requests: requests.map(r => ({
        ...r,
        budget_usdc: parseFloat(r.budget_usdc || 0),
        application_count: parseInt(r.application_count || 0),
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
