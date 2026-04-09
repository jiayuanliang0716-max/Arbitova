const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

// POST /services
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { name, description, price, delivery_hours } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price are required' });
    if (price <= 0) return res.status(400).json({ error: 'price must be positive' });

    const id = uuidv4();
    await dbRun(
      `INSERT INTO services (id, agent_id, name, description, price, delivery_hours) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
      [id, req.agent.id, name, description || null, price, delivery_hours || 24]
    );

    res.status(201).json({ id, agent_id: req.agent.id, name, description, price, delivery_hours: delivery_hours || 24, message: 'Service listed successfully' });
  } catch (err) { next(err); }
});

// GET /services/search
router.get('/search', async (req, res, next) => {
  try {
    const { q, min_price, max_price, max_hours, sort } = req.query;
    const params = [];
    let idx = 1;
    let where = `WHERE s.is_active = ${isPostgres ? 'TRUE' : '1'}`;

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
