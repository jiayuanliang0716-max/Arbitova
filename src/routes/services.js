const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
// Note: files table is accessed directly via dbGet

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const validProductTypes = ['digital', 'ai_generated', 'external'];

// POST /services
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { name, description, price, delivery_hours,
            input_schema, output_schema, verification_rules, auto_verify, semantic_verify,
            min_seller_stake, min_buyer_trust,
            file_id, market_type, product_type,
            category } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or less' });
    if (description && description.length > 1000) return res.status(400).json({ error: 'description must be 1000 characters or less' });
    if (parseFloat(price) < 0.01) return res.status(400).json({ error: 'price must be at least 0.01 USDC' });

    // Sellers listing services with a min_seller_stake gate must also meet their own gate
    const minStake = parseFloat(min_seller_stake || 0);
    if (minStake > 0 && parseFloat(req.agent.stake || 0) < minStake) {
      return res.status(400).json({ error: `Your stake (${req.agent.stake || 0}) is below the min_seller_stake (${minStake}) you set` });
    }

    // Validate file_id if provided
    let resolvedFileId = null;
    if (file_id) {
      const file = await dbGet(`SELECT id FROM files WHERE id = ${p(1)} AND uploader_id = ${p(2)}`, [file_id, req.agent.id]);
      if (!file) return res.status(400).json({ error: 'file_id not found or not owned by you' });
      resolvedFileId = file_id;
    }

    const validMarkets = ['h2a', 'a2a'];
    const mktType = validMarkets.includes(market_type) ? market_type : 'h2a';

    const prodType = validProductTypes.includes(product_type) ? product_type : 'ai_generated';

    // Product type specific validation
    if (prodType === 'digital' && !file_id) {
      return res.status(400).json({ error: 'Digital products require a file upload (file_id)' });
    }

    const id = uuidv4();
    const stringify = (v) => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));
    const svcCategory = category || 'general';
    const minBuyerTrust = parseInt(min_buyer_trust || 0);
    if (minBuyerTrust < 0 || minBuyerTrust > 100) {
      return res.status(400).json({ error: 'min_buyer_trust must be 0-100' });
    }

    await dbRun(
      `INSERT INTO services
         (id, agent_id, name, description, price, delivery_hours,
          input_schema, output_schema, verification_rules, auto_verify, semantic_verify, min_seller_stake, min_buyer_trust,
          file_id, market_type, product_type, category)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)},${p(17)})`,
      [
        id, req.agent.id, name, description || null, price, delivery_hours || 24,
        stringify(input_schema), stringify(output_schema), stringify(verification_rules),
        auto_verify     ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        semantic_verify ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        minStake, minBuyerTrust, resolvedFileId, mktType, prodType, svcCategory
      ]
    );

    res.status(201).json({
      id, agent_id: req.agent.id, name, description, price,
      delivery_hours: delivery_hours || 24,
      input_schema: input_schema || null,
      output_schema: output_schema || null,
      verification_rules: verification_rules || null,
      auto_verify: !!auto_verify,
      semantic_verify: !!semantic_verify,
      min_seller_stake: minStake,
      min_buyer_trust: minBuyerTrust,
      file_id: resolvedFileId,
      is_digital_product: !!resolvedFileId,
      market_type: mktType,
      product_type: prodType,
      category: svcCategory,
      message: 'Service listed successfully'
    });
  } catch (err) { next(err); }
});

// GET /services?agent_id=… — list a specific seller's active services (required filter).
// Arbitova is an infrastructure API, not a marketplace — there's no "browse all services" endpoint.
router.get('/', async (req, res, next) => {
  try {
    if (!req.query.agent_id) {
      return res.status(400).json({ error: 'agent_id query param is required' });
    }
    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const services = await dbAll(
      `SELECT s.*, a.name as agent_name, COALESCE(a.reputation_score, 0) as seller_reputation
       FROM services s JOIN agents a ON s.agent_id = a.id
       WHERE ${activeCheck} AND s.agent_id = ${p(1)}
       ORDER BY s.created_at DESC
       LIMIT 50`,
      [req.query.agent_id]
    );
    res.json({ count: services.length, services: services.map(s => ({ ...s, seller_reputation: parseInt(s.seller_reputation || 0) })) });
  } catch (err) { next(err); }
});

// GET /services/:id
router.get('/:id', async (req, res, next) => {
  try {
    const service = await dbGet(
      `SELECT s.*, a.name as agent_name FROM services s JOIN agents a ON s.agent_id = a.id WHERE s.id = ${p(1)}`,
      [req.params.id]
    );
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json(service);
  } catch (err) { next(err); }
});

// PATCH /services/:id
router.patch('/:id', requireApiKey, async (req, res, next) => {
  try {
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    if (service.agent_id !== req.agent.id) return res.status(403).json({ error: 'You do not own this service' });

    const { name, description, price, delivery_hours, is_active, min_buyer_trust, min_seller_stake, category } = req.body;

    if (isPostgres) {
      await dbRun(
        `UPDATE services SET
           name=COALESCE($1,name), description=COALESCE($2,description),
           price=COALESCE($3,price), delivery_hours=COALESCE($4,delivery_hours),
           is_active=COALESCE($5,is_active), category=COALESCE($6,category),
           min_buyer_trust=COALESCE($7,min_buyer_trust), min_seller_stake=COALESCE($8,min_seller_stake)
         WHERE id=$9`,
        [name||null, description||null, price||null, delivery_hours||null,
         is_active !== undefined ? is_active : null, category||null,
         min_buyer_trust !== undefined ? parseInt(min_buyer_trust) : null,
         min_seller_stake !== undefined ? parseFloat(min_seller_stake) : null,
         req.params.id]
      );
    } else {
      await dbRun(
        `UPDATE services SET
           name=COALESCE(?,name), description=COALESCE(?,description),
           price=COALESCE(?,price), delivery_hours=COALESCE(?,delivery_hours),
           is_active=COALESCE(?,is_active), category=COALESCE(?,category),
           min_buyer_trust=COALESCE(?,min_buyer_trust), min_seller_stake=COALESCE(?,min_seller_stake)
         WHERE id=?`,
        [name||null, description||null, price||null, delivery_hours||null,
         is_active !== undefined ? (is_active ? 1 : 0) : null, category||null,
         min_buyer_trust !== undefined ? parseInt(min_buyer_trust) : null,
         min_seller_stake !== undefined ? parseFloat(min_seller_stake) : null,
         req.params.id]
      );
    }

    const updated = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /services/:id — owner only, only if no active orders
router.delete('/:id', requireApiKey, async (req, res, next) => {
  try {
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    if (service.agent_id !== req.agent.id) return res.status(403).json({ error: 'You do not own this service' });

    // Block delete if there are open orders
    const activeOrders = await dbAll(
      `SELECT id FROM orders WHERE service_id = ${p(1)} AND status IN ('paid','delivered','disputed')`,
      [req.params.id]
    );
    if (activeOrders.length > 0) {
      return res.status(409).json({ error: `Cannot delete service with ${activeOrders.length} active order(s). Disable it instead.` });
    }

    await dbRun(`DELETE FROM services WHERE id = ${p(1)}`, [req.params.id]);
    res.json({ id: req.params.id, deleted: true });
  } catch (err) { next(err); }
});

// POST /services/:id/clone — duplicate a service (owner only), returns new service
router.post('/:id/clone', requireApiKey, async (req, res, next) => {
  try {
    const svc = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the owner can clone this service' });

    const newId = uuidv4();
    const clonedName = (req.body.name || svc.name + ' (copy)').slice(0, 200);

    await dbRun(
      `INSERT INTO services (id, agent_id, name, description, price, category, delivery_hours,
        market_type, auto_verify, semantic_verify, input_schema, output_schema, product_type,
        is_active, created_at)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)},
               ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)}, 0, ${p(14)})`,
      [newId, req.agent.id, clonedName, svc.description, svc.price, svc.category,
       svc.delivery_hours, svc.market_type, svc.auto_verify, svc.semantic_verify,
       svc.input_schema, svc.output_schema, svc.product_type || 'ai_generated',
       new Date().toISOString()]
    );

    const newService = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [newId]);
    res.status(201).json({ ...newService, is_active: false, cloned_from: svc.id, message: `Service cloned. New ID: ${newId}. Edit and activate when ready.` });
  } catch (err) { next(err); }
});

// POST /services/:id/rate-card — set volume pricing tiers (seller only)
// Rate card = array of { min_orders, price } sorted ascending by min_orders.
// When a buyer places an order, the applicable tier is selected based on
// how many completed orders the buyer has with this seller.
//
// Example: [{ min_orders: 1, price: 10 }, { min_orders: 6, price: 8 }, { min_orders: 11, price: 6 }]
// Orders 1-5: $10, orders 6-10: $8, orders 11+: $6
router.post('/:id/rate-card', requireApiKey, async (req, res, next) => {
  try {
    const svc = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (svc.agent_id !== req.agent.id) return res.status(403).json({ error: 'Only the owner can set rate card' });

    const { tiers } = req.body;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return res.status(400).json({ error: 'tiers must be a non-empty array of { min_orders, price }' });
    }
    for (const t of tiers) {
      if (typeof t.min_orders !== 'number' || t.min_orders < 1) {
        return res.status(400).json({ error: 'Each tier must have min_orders >= 1' });
      }
      if (typeof t.price !== 'number' || t.price < 0.01) {
        return res.status(400).json({ error: 'Each tier must have price >= 0.01 USDC' });
      }
    }

    // Sort ascending by min_orders; first tier should be min_orders = 1
    const sorted = [...tiers].sort((a, b) => a.min_orders - b.min_orders);
    const rateCardJson = JSON.stringify(sorted);

    await dbRun(
      `UPDATE services SET rate_card = ${p(1)} WHERE id = ${p(2)}`,
      [rateCardJson, svc.id]
    );

    res.json({
      service_id: svc.id,
      rate_card: sorted,
      base_price: svc.price,
      message: `Rate card set. ${sorted.length} tier(s). Buyers will see discounted prices based on order history.`,
    });
  } catch (err) { next(err); }
});

// GET /services/:id/rate-card — public, view pricing tiers for a service
router.get('/:id/rate-card', async (req, res, next) => {
  try {
    const svc = await dbGet(
      `SELECT id, name, price, rate_card FROM services WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const tiers = svc.rate_card
      ? (typeof svc.rate_card === 'string' ? JSON.parse(svc.rate_card) : svc.rate_card)
      : null;

    res.json({
      service_id: svc.id,
      service_name: svc.name,
      base_price: svc.price,
      rate_card: tiers,
      has_volume_discount: tiers !== null && tiers.length > 0,
    });
  } catch (err) { next(err); }
});

// GET /services/:id/my-price — returns the price this authenticated buyer would pay
// (applies rate card based on buyer's completed order count with this seller)
router.get('/:id/my-price', requireApiKey, async (req, res, next) => {
  try {
    const svc = await dbGet(
      `SELECT id, name, price, rate_card, agent_id FROM services WHERE id = ${p(1)}`,
      [req.params.id]
    );
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const tiers = svc.rate_card
      ? (typeof svc.rate_card === 'string' ? JSON.parse(svc.rate_card) : svc.rate_card)
      : null;

    let effectivePrice = svc.price;
    let appliedTier = null;

    if (tiers && tiers.length > 0) {
      // Count buyer's completed orders with this seller
      const buyerHistory = await dbGet(
        `SELECT COUNT(*) as cnt FROM orders
         WHERE buyer_id = ${p(1)} AND seller_id = ${p(2)} AND status = 'completed'`,
        [req.agent.id, svc.agent_id]
      );
      const completedOrders = parseInt(buyerHistory?.cnt || 0);

      // Find highest applicable tier
      const applicable = tiers
        .filter(t => completedOrders >= t.min_orders - 1) // -1 because this would be their next order
        .sort((a, b) => b.min_orders - a.min_orders);

      if (applicable.length > 0) {
        appliedTier = applicable[0];
        effectivePrice = appliedTier.price;
      }
    }

    res.json({
      service_id: svc.id,
      service_name: svc.name,
      base_price: svc.price,
      your_price: effectivePrice,
      discount_applied: effectivePrice < svc.price,
      discount_percent: svc.price > 0
        ? parseFloat(((svc.price - effectivePrice) / svc.price * 100).toFixed(1))
        : 0,
      applied_tier: appliedTier,
      rate_card: tiers,
    });
  } catch (err) { next(err); }
});

module.exports = router;
