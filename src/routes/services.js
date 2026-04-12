const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
// Note: files table is accessed directly via dbGet

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const validProductTypes = ['digital', 'ai_generated', 'subscription', 'external'];

// POST /services
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { name, description, price, delivery_hours,
            input_schema, output_schema, verification_rules, auto_verify, semantic_verify,
            min_seller_stake, min_buyer_trust,
            sub_price, sub_interval, file_id, market_type, product_type,
            category } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
    if (name.length > 100) return res.status(400).json({ error: 'name must be 100 characters or less' });
    if (description && description.length > 1000) return res.status(400).json({ error: 'description must be 1000 characters or less' });
    if (price <= 0) return res.status(400).json({ error: 'price must be positive' });

    // Sellers listing services with a min_seller_stake gate must also meet their own gate
    const minStake = parseFloat(min_seller_stake || 0);
    if (minStake > 0 && parseFloat(req.agent.stake || 0) < minStake) {
      return res.status(400).json({ error: `Your stake (${req.agent.stake || 0}) is below the min_seller_stake (${minStake}) you set` });
    }

    const validIntervals = ['daily', 'weekly', 'monthly'];
    const subInterval = sub_interval && validIntervals.includes(sub_interval) ? sub_interval : null;
    const subPrice = subInterval ? parseFloat(sub_price || 0) : 0;

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
    if (prodType === 'subscription') {
      if (!sub_interval || !['daily','weekly','monthly'].includes(sub_interval)) {
        return res.status(400).json({ error: 'Subscription services require a valid sub_interval (daily/weekly/monthly)' });
      }
      if (!sub_price || parseFloat(sub_price) <= 0) {
        return res.status(400).json({ error: 'Subscription services require sub_price > 0' });
      }
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
          sub_price, sub_interval, file_id, market_type, product_type, category)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)},${p(17)},${p(18)},${p(19)})`,
      [
        id, req.agent.id, name, description || null, price, delivery_hours || 24,
        stringify(input_schema), stringify(output_schema), stringify(verification_rules),
        auto_verify     ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        semantic_verify ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        minStake, minBuyerTrust, subPrice, subInterval, resolvedFileId, mktType, prodType, svcCategory
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
      sub_price: subPrice,
      sub_interval: subInterval,
      file_id: resolvedFileId,
      is_digital_product: !!resolvedFileId,
      market_type: mktType,
      product_type: prodType,
      category: svcCategory,
      message: 'Service listed successfully'
    });
  } catch (err) { next(err); }
});

// GET /services — list all active services (optional ?agent_id= filter)
router.get('/', async (req, res, next) => {
  try {
    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const params = [];
    let idx = 1;
    let where = `WHERE ${activeCheck}`;
    if (req.query.agent_id) {
      where += ` AND s.agent_id = ${p(idx++)}`; params.push(req.query.agent_id);
    }
    const services = await dbAll(
      `SELECT s.*, a.name as agent_name, COALESCE(a.reputation_score, 0) as seller_reputation
       FROM services s JOIN agents a ON s.agent_id = a.id
       ${where}
       ORDER BY COALESCE(a.reputation_score, 0) DESC, s.created_at DESC
       LIMIT 50`,
      params
    );
    res.json({ count: services.length, services: services.map(s => ({ ...s, seller_reputation: parseInt(s.seller_reputation || 0) })) });
  } catch (err) { next(err); }
});

// POST /services/discover — capability-based matching
// Body: { input_like: object|schema, output_like: object|schema, max_price?, limit? }
router.post('/discover', async (req, res, next) => {
  try {
    const { input_like, output_like, max_price, limit } = req.body || {};
    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const params = [];
    let idx = 1;
    let where = `WHERE ${activeCheck}`;
    if (max_price != null) { where += ` AND s.price <= ${p(idx++)}`; params.push(parseFloat(max_price)); }

    const services = await dbAll(
      `SELECT s.*, a.name as agent_name, COALESCE(a.reputation_score, 0) as seller_reputation
       FROM services s JOIN agents a ON s.agent_id = a.id
       ${where}`,
      params
    );

    // Scoring:
    //   - If service has input_schema, check that it can accept `input_like`
    //     (a non-null value passes if input_schema compile+validate succeeds, OR if
    //      `input_like` is itself a schema we compare required-key overlap)
    //   - If service has output_schema, check that its required keys ⊇ output_like required keys
    //   - Score by schema overlap + reputation
    const { parseSchemaField, validateAgainstSchema } = require('../verify');
    function keysOf(schema) {
      if (!schema || typeof schema !== 'object') return [];
      const req = Array.isArray(schema.required) ? schema.required : [];
      const props = schema.properties ? Object.keys(schema.properties) : [];
      return Array.from(new Set([...req, ...props]));
    }
    const wantOutKeys = keysOf(output_like);

    const hasCriteria = input_like != null || wantOutKeys.length > 0;

    const scored = services.map(s => {
      const sIn = parseSchemaField(s.input_schema);
      const sOut = parseSchemaField(s.output_schema);
      let score = hasCriteria ? 0 : 1; // base score when no criteria = list all
      let reasons = [];

      if (input_like != null) {
        if (!sIn) {
          // No declared input contract — accept but no bonus
          score += 1;
          reasons.push('unstructured input accepted');
        } else {
          // If input_like looks like an instance (no .type/.properties), validate directly
          const looksLikeInstance = !(input_like && typeof input_like === 'object' && (input_like.type || input_like.properties));
          if (looksLikeInstance) {
            const r = validateAgainstSchema(sIn, input_like);
            if (r.ok) { score += 5; reasons.push('input matches schema'); }
            else reasons.push('input incompatible');
          } else {
            // Schema vs schema: overlap of property keys
            const sInKeys = keysOf(sIn);
            const wantInKeys = keysOf(input_like);
            const overlap = wantInKeys.filter(k => sInKeys.includes(k)).length;
            if (overlap > 0) { score += 2 + overlap; reasons.push(`input keys overlap ${overlap}`); }
          }
        }
      }

      if (wantOutKeys.length > 0) {
        if (!sOut) {
          reasons.push('no output contract');
        } else {
          const sOutKeys = keysOf(sOut);
          const covered = wantOutKeys.every(k => sOutKeys.includes(k));
          if (covered) { score += 5; reasons.push('output covers wanted keys'); }
          else reasons.push('output missing keys');
        }
      }

      score += Math.min(parseInt(s.seller_reputation || 0), 100) / 20; // rep bonus up to 5
      return { service: s, score, reasons };
    })
    .filter(x => !hasCriteria || x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(parseInt(limit) || 20, 50));

    res.json({
      count: scored.length,
      matches: scored.map(x => ({
        ...x.service,
        seller_reputation: parseInt(x.service.seller_reputation || 0),
        match_score: parseFloat(x.score.toFixed(2)),
        match_reasons: x.reasons
      }))
    });
  } catch (err) { next(err); }
});

// GET /services/search
router.get('/search', async (req, res, next) => {
  try {
    const { q, min_price, max_price, max_hours, sort, market } = req.query;
    const params = [];
    let idx = 1;
    let where = `WHERE s.is_active = ${isPostgres ? 'TRUE' : '1'}`;
    if (market === 'h2a' || market === 'a2a') {
      where += ` AND s.market_type = ${p(idx++)}`; params.push(market);
    }
    if (req.query.product_type && validProductTypes.includes(req.query.product_type)) {
      where += ` AND s.product_type = ${p(idx++)}`;
      params.push(req.query.product_type);
    }

    if (q) {
      where += isPostgres
        ? ` AND (s.name ILIKE $${idx} OR s.description ILIKE $${idx+1})`
        : ` AND (s.name LIKE ? OR s.description LIKE ?)`;
      params.push(`%${q}%`, `%${q}%`);
      idx += 2;
    }
    if (min_price) { where += ` AND s.price >= ${p(idx++)}`; params.push(parseFloat(min_price)); }
    if (max_price) { where += ` AND s.price <= ${p(idx++)}`; params.push(parseFloat(max_price)); }
    if (max_hours) { where += ` AND s.delivery_hours <= ${p(idx++)}`; params.push(parseInt(max_hours)); }

    let orderBy;
    switch (sort) {
      case 'price_asc':  orderBy = 'ORDER BY s.price ASC, s.created_at DESC'; break;
      case 'price_desc': orderBy = 'ORDER BY s.price DESC, s.created_at DESC'; break;
      case 'newest':     orderBy = 'ORDER BY s.created_at DESC'; break;
      case 'reputation':
      default:           orderBy = 'ORDER BY COALESCE(a.reputation_score, 0) DESC, s.created_at DESC';
    }

    const services = await dbAll(
      `SELECT s.*, a.name as agent_name, COALESCE(a.reputation_score, 0) as seller_reputation
       FROM services s JOIN agents a ON s.agent_id = a.id
       ${where} ${orderBy} LIMIT 50`,
      params
    );

    res.json({ count: services.length, services: services.map(s => ({
      ...s,
      seller_reputation: parseInt(s.seller_reputation || 0)
    })) });
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

// GET /services/:id/analytics — per-service stats (owner only)
router.get('/:id/analytics', requireApiKey, async (req, res, next) => {
  try {
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    if (service.agent_id !== req.agent.id) return res.status(403).json({ error: 'Not your service' });

    const [orders, reviews, dailyRevenue] = await Promise.all([
      dbAll(
        `SELECT status, COUNT(*) as cnt, COALESCE(SUM(amount), 0) as vol
         FROM orders WHERE service_id = ${p(1)} GROUP BY status`,
        [service.id]
      ),
      dbAll(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as count FROM reviews WHERE service_id = ${p(1)}`,
        [service.id]
      ),
      dbAll(
        `SELECT ${isPostgres ? "DATE_TRUNC('day', completed_at)" : "DATE(completed_at)"} as day,
                COUNT(*) as cnt, COALESCE(SUM(amount * 0.995), 0) as rev
         FROM orders WHERE service_id = ${p(1)} AND status = 'completed'
           AND completed_at >= ${isPostgres ? "NOW() - INTERVAL '30 days'" : "datetime('now', '-30 days')"}
         GROUP BY 1 ORDER BY 1`,
        [service.id]
      ),
    ]);

    const byStatus = {};
    let total = 0;
    let totalRevenue = 0;
    for (const r of orders) {
      byStatus[r.status] = { count: parseInt(r.cnt), volume: parseFloat(r.vol) };
      total += parseInt(r.cnt);
      if (r.status === 'completed') totalRevenue = parseFloat(r.vol) * 0.995;
    }

    res.json({
      service_id: service.id,
      service_name: service.name,
      price: parseFloat(service.price),
      is_active: !!service.is_active,
      totals: {
        orders: total,
        completed: byStatus['completed']?.count || 0,
        revenue_net: totalRevenue,
        avg_rating: parseFloat(reviews[0]?.avg_rating || 0).toFixed(2),
        review_count: parseInt(reviews[0]?.count || 0),
      },
      by_status: byStatus,
      daily_revenue_30d: dailyRevenue.map(r => ({
        day: r.day,
        orders: parseInt(r.cnt),
        revenue: parseFloat(r.rev),
      })),
    });
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

// GET /services/pricing-benchmark — market rate analysis for a category.
// Public, no auth required. Returns median, min, max, P25, P75 prices for active services.
// Helps sellers price competitively. Can filter by category and delivery_hours range.
router.get('/pricing-benchmark', async (req, res, next) => {
  try {
    const category = req.query.category;
    const maxDeliveryHours = parseInt(req.query.max_delivery_hours) || null;

    let query = `SELECT price, delivery_hours, category FROM services WHERE (is_active = 1 OR is_active = true)`;
    const params = [];
    let idx = 1;

    if (category) {
      query += ` AND category = ${p(idx++)}`;
      params.push(category);
    }
    if (maxDeliveryHours) {
      query += ` AND delivery_hours <= ${p(idx++)}`;
      params.push(maxDeliveryHours);
    }
    query += ` ORDER BY price ASC`;

    const services = await dbAll(query, params);
    if (services.length === 0) {
      return res.json({ category: category || 'all', count: 0, message: 'No active services found for this filter.' });
    }

    const prices = services.map(s => parseFloat(s.price)).sort((a, b) => a - b);
    const count = prices.length;
    const median = count % 2 === 0
      ? (prices[count/2 - 1] + prices[count/2]) / 2
      : prices[Math.floor(count/2)];
    const p25 = prices[Math.floor(count * 0.25)];
    const p75 = prices[Math.floor(count * 0.75)];
    const mean = prices.reduce((a, b) => a + b, 0) / count;

    // Category breakdown
    const byCategory = {};
    for (const s of services) {
      const cat = s.category || 'general';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(parseFloat(s.price));
    }
    const categoryStats = Object.entries(byCategory).map(([cat, catPrices]) => ({
      category: cat,
      count: catPrices.length,
      median: catPrices.sort((a, b) => a - b)[Math.floor(catPrices.length / 2)],
      min: Math.min(...catPrices),
      max: Math.max(...catPrices),
    })).sort((a, b) => b.count - a.count);

    res.json({
      filter: { category: category || 'all', max_delivery_hours: maxDeliveryHours || null },
      count,
      currency: 'USDC',
      price_stats: {
        min: prices[0],
        max: prices[count - 1],
        mean: parseFloat(mean.toFixed(4)),
        median: parseFloat(median.toFixed(4)),
        p25: parseFloat(p25.toFixed(4)),
        p75: parseFloat(p75.toFixed(4)),
      },
      pricing_advice: {
        budget: `< ${parseFloat(p25.toFixed(2))} USDC — likely undercutting market`,
        competitive: `${parseFloat(p25.toFixed(2))} – ${parseFloat(p75.toFixed(2))} USDC — in-market range`,
        premium: `> ${parseFloat(p75.toFixed(2))} USDC — premium positioning (justify with credentials/reviews)`,
      },
      by_category: categoryStats,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// GET /services/trending — top services by recent order volume.
// Public, no auth required. Returns top 20 services with order velocity in the last 7 days.
// Useful for buyers discovering high-demand, proven services.
router.get('/trending', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const category = req.query.category;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Count recent orders per service
    let orderQuery = `
      SELECT o.service_id, COUNT(*) as order_count, SUM(o.amount) as total_volume
      FROM orders o
      WHERE o.created_at > ${p(1)} AND o.service_id IS NOT NULL
        AND o.status IN ('paid', 'delivered', 'completed')
      GROUP BY o.service_id
      ORDER BY order_count DESC
      LIMIT ${p(2)}
    `;
    const recentOrders = await dbAll(orderQuery, [since, limit * 3]);

    if (!recentOrders.length) {
      return res.json({ period_days: days, category: category || null, count: 0, services: [] });
    }

    const serviceIds = recentOrders.map(r => r.service_id);
    // Fetch service details for those IDs
    const placeholders = serviceIds.map((_, i) => p(i + 1)).join(',');
    let svcQuery = `
      SELECT s.id, s.name, s.description, s.price, s.delivery_hours, s.category,
             a.id as agent_id, a.name as agent_name, a.reputation_score
      FROM services s
      JOIN agents a ON a.id = s.agent_id
      WHERE s.id IN (${placeholders}) AND (s.is_active = 1 OR s.is_active = true)
    `;
    const params = [...serviceIds];
    if (category) {
      svcQuery += ` AND s.category = ${p(params.length + 1)}`;
      params.push(category);
    }
    const services = await dbAll(svcQuery, params);

    // Merge order counts + rank
    const orderMap = {};
    for (const r of recentOrders) orderMap[r.service_id] = r;

    const results = services
      .map(svc => ({
        rank: 0,
        id: svc.id,
        name: svc.name,
        description: svc.description,
        price: svc.price,
        delivery_hours: svc.delivery_hours,
        category: svc.category,
        agent: { id: svc.agent_id, name: svc.agent_name, reputation_score: svc.reputation_score },
        recent_orders: orderMap[svc.id]?.order_count || 0,
        recent_volume_usdc: parseFloat((orderMap[svc.id]?.total_volume || 0).toFixed(4)),
      }))
      .sort((a, b) => b.recent_orders - a.recent_orders)
      .slice(0, limit)
      .map((svc, i) => ({ ...svc, rank: i + 1 }));

    res.json({
      period_days: days,
      category: category || null,
      count: results.length,
      generated_at: new Date().toISOString(),
      services: results,
    });
  } catch (err) { next(err); }
});

// ── GET /services/recommend — keyword-scored service recommendation ───────────
// Scores available services by keyword overlap with the buyer's task description,
// weighted by trust score, avg rating, and price fit. Returns ranked candidates.
router.get('/recommend', async (req, res, next) => {
  try {
    const { task, max_price_usdc, category, limit = 5 } = req.query;
    if (!task || task.trim().length < 3) {
      return res.status(400).json({ error: 'task description is required (min 3 chars)' });
    }

    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    let query = `
      SELECT s.*, a.reputation_score, a.name AS agent_name,
             (SELECT AVG(r.rating) FROM reviews r
              JOIN orders o ON r.order_id = o.id
              WHERE o.service_id = s.id) AS avg_rating
      FROM services s
      JOIN agents a ON s.agent_id = a.id
      WHERE s.${activeCheck}
    `;
    const params = [];
    let pi = 1;

    if (category) {
      query += ` AND s.category = ${p(pi++)}`;
      params.push(category);
    }
    if (max_price_usdc) {
      query += ` AND s.price_usdc <= ${p(pi++)}`;
      params.push(parseFloat(max_price_usdc));
    }

    query += ` LIMIT 100`;
    const services = await dbAll(query, params);
    if (!services.length) return res.json({ query: task, results: [] });

    // Keyword scoring: split task into tokens, score by title + description overlap
    const taskTokens = task.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length >= 3);

    const scored = services.map(svc => {
      const haystack = `${svc.title || ''} ${svc.description || ''} ${svc.category || ''}`.toLowerCase();
      const keywordHits = taskTokens.filter(t => haystack.includes(t)).length;
      const keywordScore = taskTokens.length > 0 ? (keywordHits / taskTokens.length) * 50 : 0;

      const trustScore  = (parseFloat(svc.reputation_score) || 50) * 0.25;
      const ratingScore = svc.avg_rating ? (parseFloat(svc.avg_rating) / 5) * 15 : 0;
      const priceScore  = max_price_usdc
        ? Math.max(0, 10 * (1 - parseFloat(svc.price_usdc) / parseFloat(max_price_usdc)))
        : 0;

      const total = parseFloat((keywordScore + trustScore + ratingScore + priceScore).toFixed(2));
      return { ...svc, _score: total, _keyword_hits: keywordHits };
    });

    scored.sort((a, b) => b._score - a._score);
    const results = scored.slice(0, Math.min(parseInt(limit) || 5, 20)).map(svc => ({
      service_id: svc.id,
      title: svc.title,
      description: svc.description,
      category: svc.category,
      price_usdc: parseFloat(svc.price_usdc),
      seller_id: svc.agent_id,
      seller_name: svc.agent_name,
      seller_trust_score: parseFloat(svc.reputation_score) || 50,
      avg_rating: svc.avg_rating ? parseFloat(parseFloat(svc.avg_rating).toFixed(2)) : null,
      relevance_score: svc._score,
      keyword_hits: svc._keyword_hits,
      total_task_keywords: taskTokens.length,
    }));

    res.json({
      query: task,
      filters: { category: category || null, max_price_usdc: max_price_usdc ? parseFloat(max_price_usdc) : null },
      result_count: results.length,
      results,
    });
  } catch (err) { next(err); }
});

module.exports = router;
