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
            min_seller_stake, sub_price, sub_interval, file_id, market_type, product_type,
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
    await dbRun(
      `INSERT INTO services
         (id, agent_id, name, description, price, delivery_hours,
          input_schema, output_schema, verification_rules, auto_verify, semantic_verify, min_seller_stake,
          sub_price, sub_interval, file_id, market_type, product_type, category)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)},${p(17)},${p(18)})`,
      [
        id, req.agent.id, name, description || null, price, delivery_hours || 24,
        stringify(input_schema), stringify(output_schema), stringify(verification_rules),
        auto_verify     ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        semantic_verify ? (isPostgres ? true : 1) : (isPostgres ? false : 0),
        minStake, subPrice, subInterval, resolvedFileId, mktType, prodType, svcCategory
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

    const { name, description, price, delivery_hours, is_active } = req.body;

    if (isPostgres) {
      await dbRun(
        `UPDATE services SET name=COALESCE($1,name), description=COALESCE($2,description), price=COALESCE($3,price), delivery_hours=COALESCE($4,delivery_hours), is_active=COALESCE($5,is_active) WHERE id=$6`,
        [name||null, description||null, price||null, delivery_hours||null, is_active !== undefined ? is_active : null, req.params.id]
      );
    } else {
      await dbRun(
        `UPDATE services SET name=COALESCE(?,name), description=COALESCE(?,description), price=COALESCE(?,price), delivery_hours=COALESCE(?,delivery_hours), is_active=COALESCE(?,is_active) WHERE id=?`,
        [name||null, description||null, price||null, delivery_hours||null, is_active !== undefined ? (is_active ? 1 : 0) : null, req.params.id]
      );
    }

    const updated = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [req.params.id]);
    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
