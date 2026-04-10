'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// ── POST /reviews ────────────────────────────────────────────────────────────
// Authenticated: buyer submits a rating + optional comment after order completion.
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { order_id, rating, comment } = req.body;

    // ── Input validation ────────────────────────────────────────────────────
    if (!order_id) {
      return res.status(400).json({ error: 'order_id is required' });
    }
    if (rating === undefined || rating === null) {
      return res.status(400).json({ error: 'rating is required' });
    }
    const ratingInt = parseInt(rating, 10);
    if (isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    }

    // ── Fetch & validate order ──────────────────────────────────────────────
    const order = await dbGet(
      `SELECT id, buyer_id, seller_id, service_id, status FROM orders WHERE id = ${p(1)}`,
      [order_id]
    );
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.status !== 'completed') {
      return res.status(400).json({ error: 'Order must be completed before leaving a review' });
    }
    if (order.buyer_id !== req.agent.id) {
      return res.status(403).json({ error: 'Only the buyer of an order can submit a review' });
    }

    // ── Prevent duplicate reviews for the same order ────────────────────────
    const existing = await dbGet(
      `SELECT id FROM reviews WHERE order_id = ${p(1)}`,
      [order_id]
    );
    if (existing) {
      return res.status(409).json({ error: 'A review for this order already exists' });
    }

    // ── Insert review ───────────────────────────────────────────────────────
    const reviewId = uuidv4();
    await dbRun(
      `INSERT INTO reviews (id, order_id, service_id, reviewer_id, seller_id, rating, comment)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})`,
      [reviewId, order_id, order.service_id, req.agent.id, order.seller_id, ratingInt, comment || null]
    );

    const review = await dbGet(`SELECT * FROM reviews WHERE id = ${p(1)}`, [reviewId]);
    return res.status(201).json({ review });
  } catch (err) {
    next(err);
  }
});

// ── GET /reviews/service/:serviceId ─────────────────────────────────────────
// Public: all reviews for a given service, with reviewer name and aggregates.
router.get('/service/:serviceId', async (req, res, next) => {
  try {
    const { serviceId } = req.params;

    const service = await dbGet(`SELECT id, name FROM services WHERE id = ${p(1)}`, [serviceId]);
    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const reviews = await dbAll(
      `SELECT r.id, r.order_id, r.service_id, r.reviewer_id, r.seller_id,
              r.rating, r.comment, r.created_at,
              a.name AS reviewer_name
       FROM reviews r
       JOIN agents a ON a.id = r.reviewer_id
       WHERE r.service_id = ${p(1)}
       ORDER BY r.created_at DESC`,
      [serviceId]
    );

    const aggregate = await dbGet(
      `SELECT COUNT(*) AS total_reviews,
              AVG(CAST(rating AS FLOAT)) AS average_rating
       FROM reviews
       WHERE service_id = ${p(1)}`,
      [serviceId]
    );

    return res.json({
      service_id: serviceId,
      service_name: service.name,
      total_reviews: parseInt(aggregate.total_reviews, 10) || 0,
      average_rating: aggregate.average_rating
        ? Math.round(parseFloat(aggregate.average_rating) * 100) / 100
        : null,
      reviews
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /reviews/agent/:agentId ──────────────────────────────────────────────
// Public: all reviews received by a seller, with service name and aggregates.
router.get('/agent/:agentId', async (req, res, next) => {
  try {
    const { agentId } = req.params;

    const agent = await dbGet(`SELECT id, name FROM agents WHERE id = ${p(1)}`, [agentId]);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const reviews = await dbAll(
      `SELECT r.id, r.order_id, r.service_id, r.reviewer_id, r.seller_id,
              r.rating, r.comment, r.created_at,
              s.name AS service_name,
              a.name AS reviewer_name
       FROM reviews r
       JOIN services s ON s.id = r.service_id
       JOIN agents  a ON a.id = r.reviewer_id
       WHERE r.seller_id = ${p(1)}
       ORDER BY r.created_at DESC`,
      [agentId]
    );

    const aggregate = await dbGet(
      `SELECT COUNT(*) AS total_reviews,
              AVG(CAST(rating AS FLOAT)) AS average_rating
       FROM reviews
       WHERE seller_id = ${p(1)}`,
      [agentId]
    );

    return res.json({
      agent_id: agentId,
      agent_name: agent.name,
      total_reviews: parseInt(aggregate.total_reviews, 10) || 0,
      average_rating: aggregate.average_rating
        ? Math.round(parseFloat(aggregate.average_rating) * 100) / 100
        : null,
      reviews
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
