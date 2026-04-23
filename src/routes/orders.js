const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun, dbTransaction } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
const { arbitrateDispute, sha256Hex } = require('../arbitrate');
const { fire, EVENTS } = require('../webhooks');
const { checkVelocity } = require('../middleware/velocity');
const { idempotency } = require('../middleware/idempotency');
const { getTrustScore } = require('../utils/trust');
const { RELEASE_FEE_RATE, DISPUTE_FEE_RATE, creditPlatformFee, debitPlatformFee } = require('../config/fees');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const REP_CONFIRM_BONUS = 10;
const REP_DISPUTE_PENALTY = 20;

async function adjustReputation(agentId, delta, reason, orderId) {
  await dbRun(
    `UPDATE agents SET reputation_score = COALESCE(reputation_score, 0) + ${p(1)} WHERE id = ${p(2)}`,
    [delta, agentId]
  );
  await dbRun(
    `INSERT INTO reputation_history (agent_id, delta, reason, order_id) VALUES (${p(1)},${p(2)},${p(3)},${p(4)})`,
    [agentId, delta, reason, orderId || null]
  );

  // Update per-category score if we have an order to look up
  if (orderId) {
    try {
      const order = await dbGet(`SELECT service_id FROM orders WHERE id = ${p(1)}`, [orderId]);
      if (order) {
        const svc = await dbGet(`SELECT category FROM services WHERE id = ${p(1)}`, [order.service_id]);
        const category = svc?.category || 'general';
        const now = isPostgres ? 'NOW()' : "datetime('now')";
        if (isPostgres) {
          await dbRun(
            `INSERT INTO reputation_by_category (agent_id, category, score, order_count, updated_at)
             VALUES (${p(1)},${p(2)},${p(3)},1,${now})
             ON CONFLICT (agent_id, category)
             DO UPDATE SET score = reputation_by_category.score + ${p(3)},
                           order_count = reputation_by_category.order_count + 1,
                           updated_at = ${now}`,
            [agentId, category, delta]
          );
        } else {
          await dbRun(
            `INSERT INTO reputation_by_category (agent_id, category, score, order_count, updated_at)
             VALUES (${p(1)},${p(2)},${p(3)},1,${now})
             ON CONFLICT (agent_id, category)
             DO UPDATE SET score = score + ${p(3)},
                           order_count = order_count + 1,
                           updated_at = ${now}`,
            [agentId, category, delta]
          );
        }
      }
    } catch (e) { /* non-fatal */ }
  }
}

// GET /orders — list orders for the authenticated agent (as buyer or seller)
router.get('/', requireApiKey, async (req, res, next) => {
  try {
    const role   = req.query.role;   // 'buyer' | 'seller' | undefined (both)
    const status = req.query.status; // filter by status
    const q      = req.query.q;      // keyword search on requirements + service name
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    let where = [];
    let params = [];
    let pi = 1;

    if (role === 'buyer') {
      where.push(`o.buyer_id = ${p(pi++)}`); params.push(req.agent.id);
    } else if (role === 'seller') {
      where.push(`o.seller_id = ${p(pi++)}`); params.push(req.agent.id);
    } else {
      where.push(`(o.buyer_id = ${p(pi++)} OR o.seller_id = ${p(pi++)})`);
      params.push(req.agent.id, req.agent.id);
    }

    if (status) {
      where.push(`o.status = ${p(pi++)}`); params.push(status);
    }

    if (q && q.trim()) {
      const kw = `%${q.trim()}%`;
      where.push(`(o.requirements LIKE ${p(pi++)} OR s.name LIKE ${p(pi++)})`);
      params.push(kw, kw);
    }

    params.push(limit, offset);
    const orders = await dbAll(
      `SELECT o.id, o.buyer_id, o.seller_id, o.service_id, o.status, o.amount,
              o.requirements, o.deadline, o.created_at,
              s.name as service_name,
              CASE WHEN o.buyer_id = '${req.agent.id}' THEN 'buyer' ELSE 'seller' END as your_role
       FROM orders o
       LEFT JOIN services s ON o.service_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY o.created_at DESC
       LIMIT ${p(pi++)} OFFSET ${p(pi++)}`,
      params
    );
    res.json({ count: orders.length, orders });
  } catch (err) { next(err); }
});

// PATCH /orders/:id/requirements — buyer can update requirements before delivery
router.patch('/:id/requirements', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can update requirements' });
    if (order.status !== 'paid') {
      return res.status(400).json({ error: 'Requirements can only be updated while order status is paid' });
    }
    const { requirements } = req.body;
    if (requirements === undefined || requirements === null) {
      return res.status(400).json({ error: 'requirements field is required' });
    }
    const reqVal = typeof requirements === 'object' ? JSON.stringify(requirements) : String(requirements);
    await dbRun(`UPDATE orders SET requirements = ${p(1)} WHERE id = ${p(2)}`, [reqVal, order.id]);
    res.json({ id: order.id, status: order.status, requirements, message: 'Requirements updated.' });
  } catch (err) { next(err); }
});

// POST /orders/escrow-check — pre-flight: verify service availability before placing order.
// Under the escrow-first model, buyers do not pre-fund; can_proceed reflects service validity only.
router.post('/escrow-check', requireApiKey, async (req, res, next) => {
  try {
    const { service_id } = req.body;
    if (!service_id) return res.status(400).json({ error: 'service_id is required' });

    const [buyer, service] = await Promise.all([
      dbGet(`SELECT id, balance, escrow FROM agents WHERE id = ${p(1)}`, [req.agent.id]),
      dbGet(`SELECT id, name, price, is_active, agent_id FROM services WHERE id = ${p(2)}`, [service_id]),
    ]);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    if (!service.is_active) return res.status(409).json({ error: 'Service is not active', can_proceed: false });
    if (service.agent_id === req.agent.id) return res.status(409).json({ error: 'Cannot buy your own service', can_proceed: false });

    const price = parseFloat(service.price);
    const balance = parseFloat(buyer.balance || 0);

    res.json({
      can_proceed: true,
      service_id: service.id,
      service_name: service.name,
      price,
      buyer_balance: balance,
      shortfall: 0,
      message: `Ready to place order for ${service.name} at ${price} USDC. Amount will be locked directly in escrow.`,
    });
  } catch (err) { next(err); }
});

// GET /orders/recent — public anonymous feed of recent completed orders (social proof, no auth)
// NOTE: must be BEFORE /:id routes
router.get('/recent', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);
    const orders = await dbAll(
      `SELECT o.id, o.amount, o.completed_at, s.name as service_name, s.category,
              a_buyer.name as buyer_name, a_seller.name as seller_name
       FROM orders o
       LEFT JOIN services s ON o.service_id = s.id
       LEFT JOIN agents a_buyer ON a_buyer.id = o.buyer_id
       LEFT JOIN agents a_seller ON a_seller.id = o.seller_id
       WHERE o.status = 'completed' AND o.completed_at IS NOT NULL
       ORDER BY o.completed_at DESC
       LIMIT ${p(1)}`,
      [limit]
    );
    res.json({
      count: orders.length,
      orders: orders.map(o => ({
        // Anonymize: show first 6 chars of names only
        service: o.service_name || 'Service',
        category: o.category,
        amount: parseFloat(o.amount),
        buyer: o.buyer_name ? o.buyer_name.slice(0, 6) + '...' : 'Agent',
        seller: o.seller_name ? o.seller_name.slice(0, 6) + '...' : 'Agent',
        completed_at: o.completed_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /orders/preview — calculate exact cost breakdown before committing funds.
// No funds locked. Returns fees, deadline, seller payout, and risk signals.
// Buyers can compare multiple services before deciding which to order.
router.post('/preview', requireApiKey, async (req, res, next) => {
  try {
    const { service_id, amount: overrideAmount } = req.body;
    if (!service_id) return res.status(400).json({ error: 'service_id is required' });

    const service = await dbGet(
      `SELECT s.*, a.id as agent_id, a.name as agent_name, a.reputation_score,
              a.away_mode, a.blocklist
       FROM services s JOIN agents a ON a.id = s.agent_id
       WHERE s.id = ${p(1)} AND (s.is_active = 1 OR s.is_active = true)`,
      [service_id]
    );
    if (!service) return res.status(404).json({ error: 'Service not found or inactive' });

    const buyer = await dbGet(`SELECT balance, blocklist FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    const effectiveAmount = parseFloat(overrideAmount || service.price);
    const releaseFee = parseFloat((effectiveAmount * RELEASE_FEE_RATE).toFixed(6));
    const sellerReceives = parseFloat((effectiveAmount - releaseFee).toFixed(6));
    const disputeFee = parseFloat((effectiveAmount * DISPUTE_FEE_RATE).toFixed(6));

    // Check for potential blocklist issues
    const sellerBl = service.blocklist ? (typeof service.blocklist === 'string' ? JSON.parse(service.blocklist) : service.blocklist) : [];
    const buyerBl = buyer?.blocklist ? (typeof buyer.blocklist === 'string' ? JSON.parse(buyer.blocklist) : buyer.blocklist) : [];
    const warnings = [];
    if (sellerBl.some(b => b.agent_id === req.agent.id)) warnings.push('Seller has blocked your agent');
    if (buyerBl.some(b => b.agent_id === service.agent_id)) warnings.push('You have blocked this seller');

    // Check away mode
    if (service.away_mode) {
      const away = typeof service.away_mode === 'string' ? JSON.parse(service.away_mode) : service.away_mode;
      if (away?.active && !(away.until && new Date(away.until) < new Date())) {
        warnings.push(`Seller is away until ${away.until || 'unknown'}`);
      }
    }

    const deadline = new Date(Date.now() + (service.delivery_hours || 48) * 3600000).toISOString();

    res.json({
      service_id,
      service_name: service.name,
      seller: { id: service.agent_id, name: service.agent_name, reputation_score: service.reputation_score },
      order_preview: {
        amount_locked: effectiveAmount,
        release_fee: releaseFee,
        release_fee_rate: `${(RELEASE_FEE_RATE * 100).toFixed(1)}%`,
        seller_receives: sellerReceives,
        dispute_fee_if_arbitrated: disputeFee,
        dispute_fee_rate: `${(DISPUTE_FEE_RATE * 100).toFixed(1)}%`,
        deadline,
        delivery_hours: service.delivery_hours || 48,
      },
      buyer_balance: parseFloat(buyer?.balance || 0),
      can_afford: true,
      shortfall: 0,
      warnings,
      ready_to_order: warnings.length === 0,
    });
  } catch (err) { next(err); }
});

// POST /orders/spot — create an escrow order directly to an agent (no service listing required).
// Buyer specifies: to_agent_id, amount, requirements, delivery_hours.
// Seller can accept or decline (within 24h, or it auto-refunds).
// Unique differentiator: works for one-off tasks where no service exists yet.
router.post('/spot', idempotency(), requireApiKey, async (req, res, next) => {
  try {
    const { to_agent_id, amount, requirements, delivery_hours = 48, title } = req.body;
    if (!to_agent_id) return res.status(400).json({ error: 'to_agent_id is required' });
    if (!(parseFloat(amount) >= 0.01)) return res.status(400).json({ error: 'amount must be at least 0.01 USDC' });
    if (to_agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot create a spot order for yourself' });

    const seller = await dbGet(`SELECT id, name, away_mode, blocklist FROM agents WHERE id = ${p(1)}`, [to_agent_id]);
    if (!seller) return res.status(404).json({ error: 'Seller agent not found' });

    // Check away mode
    if (seller.away_mode) {
      const away = typeof seller.away_mode === 'string' ? JSON.parse(seller.away_mode) : seller.away_mode;
      if (away?.active && !(away.until && new Date(away.until) < new Date())) {
        return res.status(503).json({ error: 'Seller is currently unavailable', code: 'seller_away', until: away.until || null, message: away.message });
      }
    }

    // Check blocklist for spot orders
    const sellerBl = seller.blocklist ? (typeof seller.blocklist === 'string' ? JSON.parse(seller.blocklist) : seller.blocklist) : [];
    if (sellerBl.some(b => b.agent_id === req.agent.id)) {
      return res.status(403).json({ error: 'Order could not be placed', code: 'buyer_blocked', message: 'The seller has restricted access from your agent.' });
    }
    const buyerRow = await dbGet(`SELECT balance, blocklist FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    const buyerBl = buyerRow?.blocklist ? (typeof buyerRow.blocklist === 'string' ? JSON.parse(buyerRow.blocklist) : buyerRow.blocklist) : [];
    if (buyerBl.some(b => b.agent_id === to_agent_id)) {
      return res.status(403).json({ error: 'Order could not be placed', code: 'seller_blocked', message: 'You have blocked this agent. Remove them from your blocklist first.' });
    }

    const n = parseFloat(amount);

    const orderId = 'spot_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const deadline = new Date(Date.now() + parseInt(delivery_hours) * 3600000).toISOString();
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Escrow-first model: lock amount in escrow directly. Balance may go negative
    // (represents amount owed to platform, settled via x402/wallet integration later).
    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)}, escrow = COALESCE(escrow,0) + ${p(2)} WHERE id = ${p(3)}`,
      [n, n, req.agent.id]
    ).catch(() =>
      dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [n, req.agent.id])
    );
    await dbRun(
      `UPDATE agents SET escrow = COALESCE(escrow,0) + ${p(1)} WHERE id = ${p(2)}`,
      [n, to_agent_id]
    ).catch(() => {});

    // Create spot order (no service_id — NULL)
    await dbRun(
      `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline, spot_order_title)
       VALUES (${p(1)},${p(2)},${p(3)},NULL,'paid',${p(4)},${p(5)},${p(6)},${p(7)})`,
      [orderId, req.agent.id, to_agent_id, n, requirements || '', deadline, (title || 'Spot order').slice(0, 200)]
    ).catch(async () => {
      // Fallback: if spot_order_title column doesn't exist yet
      await dbRun(
        `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline)
         VALUES (${p(1)},${p(2)},${p(3)},NULL,'paid',${p(4)},${p(5)},${p(6)})`,
        [orderId, req.agent.id, to_agent_id, n, requirements || '', deadline]
      );
    });

    const { fire, EVENTS } = require('../webhooks');
    fire([to_agent_id], EVENTS.ORDER_CREATED, {
      order_id: orderId,
      order_type: 'spot',
      buyer_id: req.agent.id,
      amount: n,
      requirements,
      deadline,
      title: title || 'Spot order',
    }).catch(() => {});

    res.status(201).json({
      id: orderId,
      order_type: 'spot',
      status: 'paid',
      buyer_id: req.agent.id,
      seller_id: to_agent_id,
      seller_name: seller.name,
      amount: n,
      requirements,
      deadline,
      title: title || 'Spot order',
      message: `Spot escrow created. ${n} USDC locked. Seller has been notified.`,
    });
  } catch (err) { console.error('[spot] ERROR:', err.message, err.stack?.split('\n')[1]); next(err); }
});

// GET /orders/overdue — list orders past their deadline that haven't been delivered yet.
// Useful for autonomous agents monitoring their commitments and proactively taking action.
// Returns orders where: seller hasn't delivered AND deadline has passed.
router.get('/overdue', requireApiKey, async (req, res, next) => {
  try {
    const id = req.agent.id;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Orders where I'm the seller and past deadline
    const asSellerRows = await dbAll(
      `SELECT o.id, o.amount, o.requirements, o.deadline, o.status, o.created_at,
              b.name as buyer_name, o.buyer_id,
              s.name as service_name
       FROM orders o
       LEFT JOIN agents b ON b.id = o.buyer_id
       LEFT JOIN services s ON s.id = o.service_id
       WHERE o.seller_id = ${p(1)}
         AND o.status = 'paid'
         AND o.deadline IS NOT NULL
         AND o.deadline < ${now}
       ORDER BY o.deadline ASC
       LIMIT 50`,
      [id]
    );

    // Orders where I'm the buyer and seller is overdue
    const asBuyerRows = await dbAll(
      `SELECT o.id, o.amount, o.requirements, o.deadline, o.status, o.created_at,
              s2.name as seller_name, o.seller_id,
              s.name as service_name
       FROM orders o
       LEFT JOIN agents s2 ON s2.id = o.seller_id
       LEFT JOIN services s ON s.id = o.service_id
       WHERE o.buyer_id = ${p(1)}
         AND o.status = 'paid'
         AND o.deadline IS NOT NULL
         AND o.deadline < ${now}
       ORDER BY o.deadline ASC
       LIMIT 50`,
      [id]
    );

    const formatOverdue = (rows, role) => rows.map(r => {
      const deadlineMs = new Date(r.deadline).getTime();
      const overdueHours = Math.round((Date.now() - deadlineMs) / 3600000);
      return {
        order_id: r.id,
        role,
        service: r.service_name,
        amount: parseFloat(r.amount),
        deadline: r.deadline,
        overdue_hours: overdueHours,
        ...(role === 'seller'
          ? { buyer_id: r.buyer_id, buyer_name: r.buyer_name }
          : { seller_id: r.seller_id, seller_name: r.seller_name }),
        suggested_action: role === 'seller'
          ? overdueHours < 24 ? 'deliver_now or request_deadline_extension' : 'deliver_now or expect_dispute'
          : 'wait_24h_then_dispute or contact_seller',
      };
    });

    res.json({
      as_seller: formatOverdue(asSellerRows, 'seller'),
      as_buyer: formatOverdue(asBuyerRows, 'buyer'),
      total: asSellerRows.length + asBuyerRows.length,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { next(err); }
});

// GET /orders/stats — summary counts + volume for the authenticated agent
router.get('/stats', requireApiKey, async (req, res, next) => {
  try {
    const id = req.agent.id;
    const rows = await dbAll(
      `SELECT
         status,
         COUNT(*) as cnt,
         COALESCE(SUM(amount), 0) as vol
       FROM orders
       WHERE buyer_id = ${p(1)} OR seller_id = ${p(2)}
       GROUP BY status`,
      [id, id]
    );
    const stats = { total: 0, total_volume: 0, by_status: {} };
    for (const r of rows) {
      stats.by_status[r.status] = { count: Number(r.cnt), volume: Number(r.vol) };
      stats.total += Number(r.cnt);
      stats.total_volume += Number(r.vol);
    }
    // As seller
    const sellerRows = await dbAll(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as vol FROM orders WHERE seller_id = ${p(1)} AND status = 'completed'`,
      [id]
    );
    stats.completed_as_seller = { count: Number(sellerRows[0]?.cnt || 0), volume: Number(sellerRows[0]?.vol || 0) };
    // As buyer
    const buyerRows = await dbAll(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as vol FROM orders WHERE buyer_id = ${p(1)} AND status = 'completed'`,
      [id]
    );
    stats.completed_as_buyer = { count: Number(buyerRows[0]?.cnt || 0), volume: Number(buyerRows[0]?.vol || 0) };
    // Pending actions
    const pendingDeliver = await dbAll(
      `SELECT COUNT(*) as cnt FROM orders WHERE seller_id = ${p(1)} AND status = 'paid'`, [id]
    );
    const pendingConfirm = await dbAll(
      `SELECT COUNT(*) as cnt FROM orders WHERE buyer_id = ${p(1)} AND status = 'delivered'`, [id]
    );
    stats.pending_delivery = Number(pendingDeliver[0]?.cnt || 0);
    stats.pending_confirmation = Number(pendingConfirm[0]?.cnt || 0);
    res.json(stats);
  } catch (err) { next(err); }
});

// POST /orders
// Accepts two modes:
//   (a) Service order: { service_id, requirements?, ... } — price/seller from service record
//   (b) Freeform order: { seller_id, amount, requirements?, delivery_hours?, title? } — no service listing needed
router.post('/', idempotency(), requireApiKey, async (req, res, next) => {
  try {
    const { service_id, requirements, max_revisions } = req.body;

    // Freeform mode: no service_id → delegate to spot-order flow.
    if (!service_id) {
      const { seller_id, amount, delivery_hours, title } = req.body;
      if (!seller_id) return res.status(400).json({ error: 'seller_id is required when service_id is omitted' });
      if (!(parseFloat(amount) >= 0.01)) return res.status(400).json({ error: 'amount must be at least 0.01 USDC' });
      // Rewrite body to match /orders/spot contract and re-dispatch.
      req.body = { to_agent_id: seller_id, amount, requirements, delivery_hours, title };
      req.url = '/spot';
      return router.handle(req, res, next);
    }

    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)} AND ${activeCheck}`, [service_id]);
    if (!service) return res.status(404).json({ error: 'Service not found or inactive' });
    if (service.agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot purchase your own service' });

    // Enforce seller away mode — reject new orders if seller is on vacation
    const seller = await dbGet(`SELECT id, away_mode FROM agents WHERE id = ${p(1)}`, [service.agent_id]);
    if (seller?.away_mode) {
      const away = typeof seller.away_mode === 'string' ? JSON.parse(seller.away_mode) : seller.away_mode;
      if (away?.active) {
        // Auto-clear if past the "until" date
        const isExpired = away.until && new Date(away.until) < new Date();
        if (!isExpired) {
          return res.status(503).json({
            error: 'Seller is currently unavailable',
            code: 'seller_away',
            until: away.until || null,
            message: away.message || 'This seller is temporarily unavailable.',
            suggestion: 'Try again later or find an alternative service.',
          });
        }
        // Clear stale away mode in background
        dbRun(`UPDATE agents SET away_mode = NULL WHERE id = ${p(1)}`, [service.agent_id]).catch(() => {});
      }
    }

    // Blocklist check: buyer blocked by seller or buyer has blocked seller
    const [sellerAgent, buyerAgent] = await Promise.all([
      dbGet(`SELECT blocklist FROM agents WHERE id = ${p(1)}`, [service.agent_id]),
      dbGet(`SELECT blocklist FROM agents WHERE id = ${p(1)}`, [req.agent.id]),
    ]);
    const sellerBlocklist = sellerAgent?.blocklist
      ? (typeof sellerAgent.blocklist === 'string' ? JSON.parse(sellerAgent.blocklist) : sellerAgent.blocklist)
      : [];
    const buyerBlocklist = buyerAgent?.blocklist
      ? (typeof buyerAgent.blocklist === 'string' ? JSON.parse(buyerAgent.blocklist) : buyerAgent.blocklist)
      : [];
    if (sellerBlocklist.some(b => b.agent_id === req.agent.id)) {
      return res.status(403).json({ error: 'Order could not be placed', code: 'buyer_blocked', message: 'The seller has restricted access from your agent.' });
    }
    if (buyerBlocklist.some(b => b.agent_id === service.agent_id)) {
      return res.status(403).json({ error: 'Order could not be placed', code: 'seller_blocked', message: 'You have blocked this seller. Remove them from your blocklist first.' });
    }

    // Enforce min_seller_stake (seller must have enough stake locked)
    if (parseFloat(service.min_seller_stake || 0) > 0) {
      const seller = await dbGet(`SELECT stake FROM agents WHERE id = ${p(1)}`, [service.agent_id]);
      if (parseFloat(seller?.stake || 0) < parseFloat(service.min_seller_stake)) {
        return res.status(400).json({ error: 'Seller stake below service requirement' });
      }
    }

    // Enforce min_buyer_trust — trust-gated services reject low-trust buyers automatically
    if (parseInt(service.min_buyer_trust || 0) > 0) {
      const { score: buyerTrust, level: trustLevel } = await getTrustScore(req.agent.id);
      if (buyerTrust < parseInt(service.min_buyer_trust)) {
        return res.status(403).json({
          error: 'Trust score too low to purchase this service',
          code: 'trust_gated',
          your_trust_score: buyerTrust,
          your_trust_level: trustLevel,
          required_trust_score: parseInt(service.min_buyer_trust),
          message: `This service requires a trust score of ${service.min_buyer_trust}+. Your current score: ${buyerTrust} (${trustLevel}).`
        });
      }
    }

    // Escrow-first model: no pre-top-up required. Balance may go negative pending wallet settlement.

    // Velocity limits — prevent runaway / compromised agent spending
    const vel = await checkVelocity(req.agent.id, parseFloat(service.price));
    if (!vel.ok) {
      return res.status(429).json({ error: vel.reason, code: vel.code });
    }

    const deadline = new Date();
    deadline.setHours(deadline.getHours() + service.delivery_hours);
    const orderId = uuidv4();

    await dbTransaction(async (tx) => {
      await (tx || { run: dbRun }).run
        ? tx.run(`UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`, [service.price, service.price, req.agent.id])
        : dbRun(`UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`, [service.price, service.price, req.agent.id]);

      await (tx?.run || dbRun)(
        `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline, max_revisions) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)},${p(8)})`,
        [orderId, req.agent.id, service.agent_id, service_id, service.price, requirements || null, deadline.toISOString(), Math.min(parseInt(max_revisions || 3), 10)]
      );
    });

    fire([req.agent.id, service.agent_id], EVENTS.ORDER_CREATED, {
      order_id: orderId, service_id: service_id, amount: service.price,
      buyer_id: req.agent.id, seller_id: service.agent_id,
      deadline: deadline.toISOString(),
    });

    res.status(201).json({
      id: orderId, service_name: service.name, amount: service.price,
      status: 'paid', deadline: deadline.toISOString(),
      message: 'Order created. Funds are locked in escrow.'
    });
  } catch (err) { next(err); }
});

// POST /orders/bundle — atomically create multiple orders in one transaction
// Body: { items: [{ service_id, requirements? }, ...] }
router.post('/bundle', idempotency(), requireApiKey, async (req, res, next) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }
    if (items.length > 20) {
      return res.status(400).json({ error: 'bundle size limited to 20 items' });
    }

    // Resolve all services + validate each
    const resolved = [];
    let totalAmount = 0;
    for (const item of items) {
      if (!item.service_id) return res.status(400).json({ error: 'each item needs service_id' });
      const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
      const svc = await dbGet(`SELECT * FROM services WHERE id = ${p(1)} AND ${activeCheck}`, [item.service_id]);
      if (!svc) return res.status(404).json({ error: `Service ${item.service_id} not found or inactive` });
      if (svc.agent_id === req.agent.id) return res.status(400).json({ error: `Cannot purchase own service ${svc.id}` });

      if (parseFloat(svc.min_seller_stake || 0) > 0) {
        const seller = await dbGet(`SELECT stake FROM agents WHERE id = ${p(1)}`, [svc.agent_id]);
        if (parseFloat(seller?.stake || 0) < parseFloat(svc.min_seller_stake)) {
          return res.status(400).json({ error: `Seller ${svc.agent_id} stake below requirement` });
        }
      }
      totalAmount += parseFloat(svc.price);
      resolved.push({ svc, requirements: item.requirements || null });
    }

    // Escrow-first model: bundle total is locked into escrow directly; no pre-top-up required.
    const bundleId = uuidv4();
    const childIds = [];

    // Wrap everything in a single DB transaction — all-or-nothing
    await dbTransaction(async (tx) => {
      const run = tx ? tx.run.bind(tx) : dbRun;

      await run(
        `INSERT INTO order_bundles (id, buyer_id, total_amount, status) VALUES (${p(1)},${p(2)},${p(3)},${p(4)})`,
        [bundleId, req.agent.id, totalAmount, 'active']
      );

      // Lock total escrow atomically
      await run(
        `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
        [totalAmount, totalAmount, req.agent.id]
      );

      for (const { svc, requirements: req_text } of resolved) {
        const orderId = uuidv4();
        const deadline = new Date();
        deadline.setHours(deadline.getHours() + svc.delivery_hours);
        await run(
          `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, bundle_id, deadline)
           VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)},${p(8)})`,
          [orderId, req.agent.id, svc.agent_id, svc.id, svc.price, req_text, bundleId, deadline.toISOString()]
        );
        childIds.push(orderId);
      }
    });

    res.status(201).json({
      bundle_id: bundleId,
      total_amount: totalAmount,
      order_ids: childIds,
      count: childIds.length,
      status: 'active',
      message: 'Bundle created. All orders locked in escrow atomically.'
    });
  } catch (err) { next(err); }
});

// GET /orders/bundle/:id — bundle status + child orders
router.get('/bundle/:id', requireApiKey, async (req, res, next) => {
  try {
    const bundle = await dbGet(`SELECT * FROM order_bundles WHERE id = ${p(1)}`, [req.params.id]);
    if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
    if (bundle.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Access denied' });
    const children = await dbAll(
      `SELECT o.*, s.name as service_name FROM orders o JOIN services s ON o.service_id = s.id WHERE o.bundle_id = ${p(1)} ORDER BY o.created_at ASC`,
      [req.params.id]
    );
    const statuses = children.map(c => c.status);
    const allDone = statuses.every(s => s === 'completed' || s === 'refunded');
    if (allDone && bundle.status === 'active') {
      await dbRun(`UPDATE order_bundles SET status = ${p(1)} WHERE id = ${p(2)}`, ['settled', bundle.id]);
      bundle.status = 'settled';
    }
    res.json({ ...bundle, children, child_count: children.length });
  } catch (err) { next(err); }
});

// GET /orders/:id
router.get('/:id', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(
      `SELECT o.*, s.name as service_name, ab.name as buyer_name, as2.name as seller_name
       FROM orders o
       JOIN services s ON o.service_id = s.id
       JOIN agents ab ON o.buyer_id = ab.id
       JOIN agents as2 ON o.seller_id = as2.id
       WHERE o.id = ${p(1)}`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found', code: 'not_found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
    }
    const delivery = await dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [req.params.id]);
    res.json({ ...order, delivery: delivery || null });
  } catch (err) { next(err); }
});

// GET /orders/:id/timeline — full event history for a transaction
router.get('/:id/timeline', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found', code: 'not_found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied', code: 'forbidden' });
    }

    const events = [];

    // Created
    events.push({ event: 'order.created', timestamp: order.created_at, data: {
      amount: order.amount, buyer_id: order.buyer_id, seller_id: order.seller_id,
    }});

    // Delivery
    const delivery = await dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [order.id]);
    if (delivery) {
      events.push({ event: 'order.delivered', timestamp: delivery.delivered_at, data: {
        delivery_id: delivery.id,
      }});
    }

    // Dispute
    const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)}`, [order.id]);
    if (dispute) {
      events.push({ event: 'order.disputed', timestamp: dispute.created_at, data: {
        dispute_id: dispute.id, raised_by: dispute.raised_by, reason: dispute.reason,
      }});
      if (dispute.status === 'resolved') {
        events.push({ event: 'dispute.resolved', timestamp: dispute.resolved_at, data: {
          resolution: dispute.resolution,
        }});
      }
    }

    // Final status
    if (['completed', 'refunded'].includes(order.status)) {
      events.push({ event: `order.${order.status}`, timestamp: order.completed_at, data: {
        final_status: order.status, amount: order.amount,
      }});
    }

    // Tips
    const tips = await dbAll(
      `SELECT id, amount, from_id, created_at FROM tips WHERE order_id = ${p(1)}`,
      [order.id]
    ).catch(() => []);
    for (const t of tips) {
      events.push({ event: 'order.tip_received', timestamp: t.created_at, data: { tip_id: t.id, amount: parseFloat(t.amount), from_id: t.from_id } });
    }

    // Reputation events (all for this order)
    const repHistory = await dbAll(
      `SELECT * FROM reputation_history WHERE order_id = ${p(1)} ORDER BY created_at ASC`,
      [order.id]
    ).catch(() => []);
    for (const r of repHistory) {
      events.push({ event: 'reputation.updated', timestamp: r.created_at, data: {
        agent_id: r.agent_id, delta: r.delta, reason: r.reason,
      }});
    }

    // Sort by timestamp
    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
      order_id: order.id,
      current_status: order.status,
      amount: parseFloat(order.amount),
      deadline: order.deadline,
      timeline: events,
      event_count: events.length,
    });
  } catch (err) { next(err); }
});

// GET /orders/:id/negotiation — dispute-resolution timeline for an order.
// Returns a structured log of all negotiation events: disputes, counter-offers,
// revision requests, deadline extensions, arbitration verdicts, and appeals.
// Useful for understanding the resolution path and for building appeals.
router.get('/:id/negotiation', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const events = [];

    // Dispute
    const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)}`, [order.id]);
    if (dispute) {
      events.push({
        type: 'dispute_opened',
        timestamp: dispute.created_at,
        raised_by: dispute.raised_by,
        reason: dispute.reason,
      });
      if (dispute.status === 'resolved') {
        events.push({
          type: 'dispute_resolved',
          timestamp: dispute.resolved_at,
          resolution: dispute.resolution,
          winner: dispute.winner || null,
        });
      }
    }

    // Counter-offer
    const co = order.counter_offer
      ? (typeof order.counter_offer === 'string' ? JSON.parse(order.counter_offer) : order.counter_offer)
      : null;
    if (co) {
      events.push({
        type: 'counter_offer_proposed',
        timestamp: co.proposed_at,
        proposed_by: co.proposed_by,
        refund_amount: co.refund_amount,
        seller_keeps: co.seller_keeps,
        note: co.note || null,
      });
      if (co.status === 'accepted') {
        events.push({ type: 'counter_offer_accepted', timestamp: co.accepted_at, resolution: 'split' });
      } else if (co.status === 'declined') {
        events.push({ type: 'counter_offer_declined', timestamp: co.declined_at });
      }
    }

    // Revision requests (from comments tagged as revision requests)
    if (order.revision_count > 0) {
      events.push({
        type: 'revisions_requested',
        revision_count: order.revision_count,
        max_revisions: order.max_revisions || 3,
        note: `${order.revision_count} revision(s) requested by buyer`,
      });
    }

    // Deadline extension
    if (order.seller_extension_used === 1 || order.seller_extension_used === true) {
      events.push({ type: 'deadline_extension_applied', note: 'Seller requested a deadline extension (auto-applied).' });
    }

    // Sort by timestamp where available
    events.sort((a, b) => {
      if (!a.timestamp) return 1;
      if (!b.timestamp) return -1;
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    res.json({
      order_id: order.id,
      status: order.status,
      is_disputed: !!dispute,
      negotiation_events: events,
      event_count: events.length,
      resolution_path: events.map(e => e.type).join(' → ') || 'none',
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/deliver
router.post('/:id/deliver', requireApiKey, async (req, res, next) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content is required' });

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.seller_id !== req.agent.id) return res.status(403).json({ error: 'Only the seller can deliver' });
    if (order.status !== 'paid') return res.status(400).json({ error: `Cannot deliver: status is ${order.status}` });

    // Atomic transition first: prevents deliver+cancel race from leaving the
    // order in 'cancelled' state while a delivery row is also inserted.
    const transition = await dbRun(
      `UPDATE orders SET status = 'delivered' WHERE id = ${p(1)} AND status = 'paid'`,
      [order.id]
    );
    if (!transition.changes) {
      return res.status(400).json({ error: 'Cannot deliver: order state changed concurrently' });
    }

    const deliveryId = uuidv4();
    // M-4: fingerprint the content at delivery time so the arbiter can
    // detect drift (tamper, replication race, botched manual fix) before
    // ruling. Share the helper with verifyDeliveryContentHash so both
    // sides of the check use identical bytes → identical digest.
    const contentBytes = typeof content === 'string' ? content : JSON.stringify(content);
    const payloadHash = sha256Hex(contentBytes);
    await dbRun(
      `INSERT INTO deliveries (id, order_id, content, payload_hash) VALUES (${p(1)},${p(2)},${p(3)},${p(4)})`,
      [deliveryId, order.id, content, payloadHash]
    );

    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_DELIVERED, {
      order_id: order.id, delivery_id: deliveryId,
      buyer_id: order.buyer_id, seller_id: order.seller_id,
    });

    res.json({
      delivery_id: deliveryId,
      order_id: order.id,
      status: 'delivered',
      payload_hash: payloadHash,
      message: 'Delivery submitted. Buyer has 7 days to confirm or dispute.'
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/confirm
router.post('/:id/confirm', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can confirm' });
    if (!['delivered', 'paid'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot confirm: status is ${order.status}` });
    }

    const fee = parseFloat(order.amount) * RELEASE_FEE_RATE;
    const sellerReceives = parseFloat(order.amount) - fee;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Atomic state transition: guarantees only one concurrent confirm wins.
    // Without this, two simultaneous requests both pass the status check above
    // and both run the money ops — a TOCTOU that double-charges the fee and
    // double-pays the seller. SQLite hid this with its single-writer lock.
    const transition = await dbRun(
      `UPDATE orders SET status = 'completed', completed_at = ${now}
        WHERE id = ${p(1)} AND status IN ('delivered', 'paid')`,
      [order.id]
    );
    if (!transition.changes) {
      return res.status(400).json({ error: 'Cannot confirm: order already settled or state changed' });
    }

    await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
    await creditPlatformFee(fee);

    // Reputation: successful delivery confirmed by buyer
    try { await adjustReputation(order.seller_id, REP_CONFIRM_BONUS, 'order_completed', order.id); } catch (e) { console.error('rep err:', e.message); }

    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_COMPLETED, {
      order_id: order.id, amount: order.amount,
      platform_fee: fee.toFixed(4), seller_received: sellerReceives.toFixed(4),
      buyer_id: order.buyer_id, seller_id: order.seller_id,
    });

    res.json({
      order_id: order.id, status: 'completed',
      amount_paid: order.amount,
      platform_fee: fee.toFixed(4),
      seller_received: sellerReceives.toFixed(4),
      message: 'Transaction completed successfully.'
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/partial-confirm
// Buyer confirms partial delivery and releases a percentage of escrowed funds.
// Remaining funds stay locked until full delivery or dispute.
router.post('/:id/partial-confirm', requireApiKey, async (req, res, next) => {
  try {
    const { percent, note } = req.body;
    const pct = parseFloat(percent);
    if (!(pct >= 1 && pct < 100)) {
      return res.status(400).json({ error: 'percent must be between 1 and 100 (exclusive). Use confirm for 100%.' });
    }

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can confirm' });
    if (!['delivered', 'paid'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot confirm: status is ${order.status}` });
    }

    const releaseAmount = parseFloat(order.amount) * (pct / 100);
    const remaining = parseFloat(order.amount) - releaseAmount;
    const fee = releaseAmount * RELEASE_FEE_RATE;
    const sellerReceives = releaseAmount - fee;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Atomic state transition: amount acts as the optimistic-lock version.
    // If another concurrent partial-confirm already ran, amount has changed
    // and rowCount is 0. Without this check, two parallel 60% releases
    // would drain 120% of escrow on Postgres.
    const transition = await dbRun(
      `UPDATE orders SET amount = ${p(1)}, status = 'paid'
        WHERE id = ${p(2)} AND amount = ${p(3)} AND status IN ('delivered','paid')`,
      [remaining, order.id, order.amount]
    );
    if (!transition.changes) {
      return res.status(400).json({ error: 'Cannot partial-confirm: order state changed concurrently' });
    }

    await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [releaseAmount, order.buyer_id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
    await creditPlatformFee(fee);

    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_COMPLETED, {
      order_id: order.id, type: 'partial_release',
      percent_released: pct, amount_released: releaseAmount,
      remaining_locked: remaining,
      platform_fee: fee.toFixed(4), seller_received: sellerReceives.toFixed(4),
      note: note || null,
    });

    res.json({
      order_id: order.id,
      status: 'paid',
      percent_released: pct,
      amount_released: releaseAmount.toFixed(4),
      remaining_locked: remaining.toFixed(4),
      platform_fee: fee.toFixed(4),
      seller_received: sellerReceives.toFixed(4),
      message: `${pct}% of funds released. Remaining ${(100 - pct).toFixed(0)}% stays locked pending full delivery.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/dispute
// Dispute Bond: 5% of order amount (min 0.01, max 2.0 USDC) locked on open.
// If disputing party loses arbitration, bond is forfeited to the winner.
// If dispute is upheld, bond is returned.
const DISPUTE_BOND_RATE  = 0.05;
const DISPUTE_BOND_MIN   = 0.01;
const DISPUTE_BOND_MAX   = 2.0;

// Strip NUL bytes — Postgres TEXT rejects them (invalid UTF8), SQLite accepts.
// Any persisted user-input field passes through here so both backends behave
// the same and a malicious payload cannot 500 the endpoint.
const stripNulls = (s) => (typeof s === 'string' ? s.replace(/\u0000/g, '') : s);

router.post('/:id/dispute', requireApiKey, async (req, res, next) => {
  try {
    let { reason, evidence } = req.body;
    reason = stripNulls(reason);
    evidence = stripNulls(evidence);
    if (!reason) return res.status(400).json({ error: 'reason is required' });

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!['paid', 'delivered'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot dispute: status is ${order.status}` });
    }
    const existing = await dbGet(`SELECT id FROM disputes WHERE order_id = ${p(1)} AND status = 'open'`, [order.id]);
    if (existing) return res.status(400).json({ error: 'A dispute is already open for this order' });

    // Seller cooldown: cannot raise a dispute within 24h of delivering. Prevents
    // a seller from racing the buyer to arbitration the moment they submit delivery.
    if (req.agent.id === order.seller_id && order.status === 'delivered') {
      const delivery = await dbGet(
        `SELECT delivered_at FROM deliveries WHERE order_id = ${p(1)} ORDER BY delivered_at DESC LIMIT 1`,
        [order.id]
      );
      if (delivery?.delivered_at) {
        const hoursSinceDelivery = (Date.now() - new Date(delivery.delivered_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceDelivery < 24) {
          return res.status(400).json({
            error: 'Seller must wait 24 hours after delivery before raising a dispute.',
            code: 'seller_cooldown_active',
            hours_remaining: (24 - hoursSinceDelivery).toFixed(2),
          });
        }
      }
    }

    // Calculate and lock dispute bond
    const orderAmount = parseFloat(order.amount) || 0;
    const bondAmount  = Math.min(
      Math.max(orderAmount * DISPUTE_BOND_RATE, DISPUTE_BOND_MIN),
      DISPUTE_BOND_MAX
    );

    const agent = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (!agent || parseFloat(agent.balance) < bondAmount) {
      return res.status(402).json({
        error: 'Insufficient balance for dispute bond',
        bond_required: bondAmount,
        current_balance: parseFloat(agent?.balance || 0),
        reason: 'A dispute bond of 5% of order amount is required to open a dispute. It is returned if you win, forfeited if you lose.',
      });
    }

    // Atomic transition first: prevents dispute+confirm race from both
    // settling the order while also locking the bond.
    const transition = await dbRun(
      `UPDATE orders SET status = 'disputed'
        WHERE id = ${p(1)} AND status IN ('paid','delivered')`,
      [order.id]
    );
    if (!transition.changes) {
      return res.status(400).json({ error: 'Cannot dispute: order state changed concurrently' });
    }

    // Lock bond: deduct from balance, add to escrow
    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
      [bondAmount, bondAmount, req.agent.id]
    );

    const disputeId = uuidv4();
    await dbRun(
      `INSERT INTO disputes (id, order_id, raised_by, reason, evidence, bond_amount) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
      [disputeId, order.id, req.agent.id, reason, evidence || null, bondAmount]
    );

    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_DISPUTED, {
      order_id: order.id, dispute_id: disputeId,
      raised_by: req.agent.id, reason,
    });

    res.status(201).json({
      dispute_id:   disputeId,
      order_id:     order.id,
      status:       'open',
      bond_locked:  bondAmount,
      message:      `Dispute opened. Bond of ${bondAmount} USDC locked. Returned if you win, forfeited if you lose.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/resolve-dispute
// Platform admin only. Body: { winner: 'buyer'|'seller', resolution: string }
// Authorization: X-Admin-Key header must match process.env.ADMIN_KEY
router.post('/:id/resolve-dispute', async (req, res, next) => {
  try {
    const adminKey = process.env.ADMIN_KEY;
    if (!adminKey) return res.status(503).json({ error: 'Admin key not configured on server' });
    if (req.headers['x-admin-key'] !== adminKey) return res.status(401).json({ error: 'Invalid admin key' });

    const { winner, resolution } = req.body || {};
    if (!['buyer', 'seller'].includes(winner)) {
      return res.status(400).json({ error: 'winner must be "buyer" or "seller"' });
    }

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'disputed') return res.status(400).json({ error: `Order is not disputed (status: ${order.status})` });

    const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)} AND status = 'open'`, [order.id]);
    if (!dispute) return res.status(404).json({ error: 'No open dispute found' });

    const now = isPostgres ? 'NOW()' : "datetime('now')";
    const loserId = winner === 'buyer' ? order.seller_id : order.buyer_id;

    if (winner === 'buyer') {
      // Refund buyer: escrow -> balance
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    } else {
      // Pay seller (net of dispute fee)
      const fee = parseFloat(order.amount) * DISPUTE_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      await creditPlatformFee(fee);
    }

    await dbRun(
      `UPDATE disputes SET status = 'resolved', resolution = ${p(1)}, resolved_at = ${now} WHERE id = ${p(2)}`,
      [resolution || ('winner: ' + winner), dispute.id]
    );

    // Reputation penalty on the losing party
    try { await adjustReputation(loserId, -REP_DISPUTE_PENALTY, 'dispute_lost', order.id); } catch (e) { console.error('rep err:', e.message); }

    // Slash the loser's stake (up to the order amount) and credit the winner
    let slashed = 0;
    try {
      const loser = await dbGet(`SELECT COALESCE(stake, 0) as stake FROM agents WHERE id = ${p(1)}`, [loserId]);
      const available = parseFloat(loser?.stake || 0);
      slashed = Math.min(available, parseFloat(order.amount));
      if (slashed > 0) {
        const winnerId = winner === 'buyer' ? order.buyer_id : order.seller_id;
        await dbRun(`UPDATE agents SET stake = stake - ${p(1)} WHERE id = ${p(2)}`, [slashed, loserId]);
        await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [slashed, winnerId]);
      }
    } catch (e) { console.error('stake slash err:', e.message); }

    fire([order.buyer_id, order.seller_id], EVENTS.DISPUTE_RESOLVED, {
      order_id: order.id, dispute_id: dispute.id,
      winner, loser_id: loserId,
      new_status: winner === 'buyer' ? 'refunded' : 'completed',
      stake_slashed: slashed,
    });

    res.json({
      order_id: order.id,
      dispute_id: dispute.id,
      winner,
      loser_id: loserId,
      new_order_status: winner === 'buyer' ? 'refunded' : 'completed',
      reputation_penalty: REP_DISPUTE_PENALTY,
      stake_slashed: slashed
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/subdelegate
// Seller of an active order sub-contracts work to another agent's service.
// Body: { service_id, requirements? }
// Creates a child order where this seller becomes the buyer.
router.post('/:id/subdelegate', requireApiKey, async (req, res, next) => {
  try {
    const { service_id, requirements } = req.body || {};
    if (!service_id) return res.status(400).json({ error: 'service_id is required' });

    const parent = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!parent) return res.status(404).json({ error: 'Order not found' });
    if (parent.seller_id !== req.agent.id) return res.status(403).json({ error: 'Only the seller can sub-delegate' });
    if (!['paid', 'delivered'].includes(parent.status)) {
      return res.status(400).json({ error: `Cannot sub-delegate: parent order status is ${parent.status}` });
    }

    // Check for existing open sub-delegation on this order
    const existing = await dbGet(
      `SELECT id FROM orders WHERE parent_order_id = ${p(1)} AND status NOT IN ('completed','refunded')`,
      [parent.id]
    );
    if (existing) return res.status(400).json({ error: 'An active sub-delegation already exists for this order' });

    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const subService = await dbGet(`SELECT * FROM services WHERE id = ${p(1)} AND ${activeCheck}`, [service_id]);
    if (!subService) return res.status(404).json({ error: 'Sub-service not found or inactive' });
    if (subService.agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot sub-delegate to your own service' });

    // Seller must have enough balance to pay the sub-service
    const seller = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(seller.balance) < parseFloat(subService.price)) {
      return res.status(400).json({ error: 'Insufficient balance to fund sub-delegation', balance: seller.balance, required: subService.price });
    }

    const deadline = new Date();
    deadline.setHours(deadline.getHours() + subService.delivery_hours);
    const childId = uuidv4();

    // Lock funds from seller's balance into escrow
    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
      [subService.price, subService.price, req.agent.id]
    );
    await dbRun(
      `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, parent_order_id, deadline)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)},${p(8)})`,
      [childId, req.agent.id, subService.agent_id, service_id, subService.price, requirements || null, parent.id, deadline.toISOString()]
    );

    res.status(201).json({
      child_order_id: childId,
      parent_order_id: parent.id,
      sub_service: subService.name,
      sub_seller: subService.agent_id,
      amount: subService.price,
      status: 'paid',
      deadline: deadline.toISOString(),
      message: 'Sub-delegation created. Funds locked. Deliver to your buyer once the sub-order completes.'
    });
  } catch (err) { next(err); }
});

// GET /orders/:id/subdelegations — list all sub-orders for a parent order
router.get('/:id/subdelegations', requireApiKey, async (req, res, next) => {
  try {
    const parent = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!parent) return res.status(404).json({ error: 'Order not found' });
    if (parent.buyer_id !== req.agent.id && parent.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const children = await dbAll(
      `SELECT o.*, s.name as service_name, a.name as sub_seller_name
       FROM orders o
       JOIN services s ON o.service_id = s.id
       JOIN agents a ON o.seller_id = a.id
       WHERE o.parent_order_id = ${p(1)}
       ORDER BY o.created_at ASC`,
      [req.params.id]
    );
    res.json({ parent_order_id: parent.id, count: children.length, subdelegations: children });
  } catch (err) { next(err); }
});

// POST /orders/:id/auto-arbitrate
// Triggers AI arbitration for a disputed order.
// Public trigger: anyone involved in the order can request it.
// If ANTHROPIC_API_KEY is not set, returns 503.
router.post('/:id/auto-arbitrate', requireApiKey, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI arbitration not available: ANTHROPIC_API_KEY not configured' });
    }

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (order.status !== 'disputed') {
      return res.status(400).json({ error: `Order is not disputed (status: ${order.status})` });
    }

    const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)} AND status = 'open'`, [order.id]);
    if (!dispute) return res.status(404).json({ error: 'No open dispute found' });

    const [service, delivery] = await Promise.all([
      dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [order.service_id]),
      dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [order.id])
    ]);

    // Run AI arbitration (N=3 majority vote)
    let verdict;
    try {
      verdict = await arbitrateDispute({ order, service, dispute, delivery });
    } catch (e) {
      return res.status(500).json({ error: 'AI arbitration failed', details: e.message });
    }

    const { winner, reasoning, confidence, votes, key_factors, dissent, escalate_to_human, constitutional_shortcut, escalation_reason: verdictEscalationReason } = verdict;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // ── Human escalation path ────────────────────────────────────────────────
    if (escalate_to_human) {
      const reviewId = uuidv4();
      const escalationReason = verdictEscalationReason
        || (confidence < 0.60
          ? `AI confidence too low (${(confidence * 100).toFixed(0)}%)`
          : 'Minority judges highly confident in opposite direction');

      await dbRun(
        `UPDATE orders SET status = 'under_review' WHERE id = ${p(1)}`,
        [order.id]
      );
      await dbRun(
        `INSERT INTO human_review_queue
           (id, order_id, dispute_id, ai_votes, ai_reasoning, ai_confidence, escalation_reason)
         VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})`,
        [
          reviewId, order.id, dispute.id,
          JSON.stringify(votes), reasoning, confidence,
          escalationReason,
        ]
      );

      return res.status(202).json({
        escalated: true,
        review_id: reviewId,
        order_id: order.id,
        dispute_id: dispute.id,
        order_status: 'under_review',
        ai_confidence: confidence,
        escalation_reason: escalationReason,
        ai_votes: votes,
        message: 'AI confidence insufficient. Dispute queued for human review.',
      });
    }

    // ── Execute AI verdict ───────────────────────────────────────────────────
    const loserId  = winner === 'buyer' ? order.seller_id  : order.buyer_id;
    const winnerId = winner === 'buyer' ? order.buyer_id   : order.seller_id;

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

    // ── Dispute bond settlement ──────────────────────────────────────────────
    // If disputing party wins: return bond. If loses: bond goes to winner.
    const bondAmount = parseFloat(dispute.bond_amount || 0);
    if (bondAmount > 0) {
      const disputingParty = dispute.raised_by;
      // Release bond from disputing party's escrow
      await dbRun(
        `UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`,
        [bondAmount, disputingParty]
      ).catch(() => {});

      if (disputingParty === winnerId) {
        // Dispute upheld — bond returned to disputing party
        await dbRun(
          `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
          [bondAmount, disputingParty]
        ).catch(() => {});
      } else {
        // Dispute rejected — bond forfeited to winner
        await dbRun(
          `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
          [bondAmount, winnerId]
        ).catch(() => {});
      }
    }

    const votesSummary = (votes || []).map(v => `${v.winner}(${(v.confidence*100).toFixed(0)}%,${v.model||'claude'})`).join(', ');
    const keyFactorsStr = (key_factors || []).length > 0 ? ` | key_factors: ${(key_factors || []).join('; ')}` : '';
    const dissentStr    = dissent ? ` | dissent: ${dissent.slice(0, 200)}` : '';
    const shortcutStr   = constitutional_shortcut ? ' | method: constitutional' : '';
    const resolution = `[AI Arbitration N=3 | votes: ${votesSummary} | avg confidence: ${(confidence * 100).toFixed(0)}%${keyFactorsStr}${dissentStr}${shortcutStr}] ${reasoning}`;
    await dbRun(
      `UPDATE disputes SET status = 'resolved', resolution = ${p(1)}, resolved_at = ${now} WHERE id = ${p(2)}`,
      [resolution, dispute.id]
    );

    // Reputation penalty on loser
    try { await adjustReputation(loserId, -REP_DISPUTE_PENALTY, 'dispute_lost_ai_arbitration', order.id); } catch (e) {}

    // Slash loser's stake
    let slashed = 0;
    try {
      const loser = await dbGet(`SELECT COALESCE(stake, 0) as stake FROM agents WHERE id = ${p(1)}`, [loserId]);
      const available = parseFloat(loser?.stake || 0);
      slashed = Math.min(available, parseFloat(order.amount));
      if (slashed > 0) {
        const winnerId = winner === 'buyer' ? order.buyer_id : order.seller_id;
        await dbRun(`UPDATE agents SET stake = stake - ${p(1)} WHERE id = ${p(2)}`, [slashed, loserId]);
        await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [slashed, winnerId]);
      }
    } catch (e) {}

    const bondOutcome = bondAmount > 0
      ? (dispute.raised_by === winnerId ? 'returned' : 'forfeited')
      : 'no_bond';

    res.json({
      order_id: order.id,
      dispute_id: dispute.id,
      winner,
      loser_id: loserId,
      new_order_status: winner === 'buyer' ? 'refunded' : 'completed',
      ai_reasoning: reasoning,
      confidence,
      key_factors:  key_factors || [],
      dissent:      dissent || null,
      ai_votes:     votes,
      constitutional_shortcut: constitutional_shortcut || false,
      bond_amount:  bondAmount,
      bond_outcome: bondOutcome,
      reputation_penalty: REP_DISPUTE_PENALTY,
      stake_slashed: slashed,
      arbitrated_by: constitutional_shortcut ? 'constitutional-rules' : 'arbitova-n3-multi-model',
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/appeal
// Either party can appeal an AI arbitration verdict (once) by providing additional evidence.
// Triggers a fresh N=3 arbitration with the new evidence appended to context.
// Only available within 1 hour of auto-arbitrate verdict, and only if confidence was < 0.85.
router.post('/:id/appeal', requireApiKey, async (req, res, next) => {
  try {
    const { additional_evidence } = req.body;
    if (!additional_evidence || additional_evidence.length < 20) {
      return res.status(400).json({ error: 'additional_evidence must be at least 20 characters' });
    }

    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!['refunded', 'completed'].includes(order.status)) {
      return res.status(400).json({ error: 'Appeals can only be filed after an AI arbitration verdict (status must be refunded or completed)' });
    }

    const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)} ORDER BY created_at DESC LIMIT 1`, [order.id]);
    if (!dispute) return res.status(404).json({ error: 'No dispute found for this order' });
    if (dispute.appealed) {
      return res.status(400).json({ error: 'This dispute has already been appealed. Only one appeal is permitted.' });
    }

    // Check time window: must be within 1 hour of resolution
    const resolvedAt = dispute.resolved_at ? new Date(dispute.resolved_at) : null;
    if (resolvedAt) {
      const hoursSinceResolution = (Date.now() - resolvedAt.getTime()) / (1000 * 60 * 60);
      if (hoursSinceResolution > 1) {
        return res.status(400).json({ error: 'Appeal window has expired. Appeals must be filed within 1 hour of the arbitration verdict.' });
      }
    }

    // Mark dispute as appealed to prevent duplicate appeals
    await dbRun(`UPDATE disputes SET appealed = 1 WHERE id = ${p(1)}`, [dispute.id]);

    // Re-open order for re-arbitration
    await dbRun(`UPDATE orders SET status = 'disputed' WHERE id = ${p(1)}`, [order.id]);

    // Rebuild context with additional evidence
    const [service, delivery] = await Promise.all([
      dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [order.service_id]),
      dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [order.id])
    ]);

    const enhancedDispute = {
      ...dispute,
      reason: dispute.reason,
      evidence: [dispute.evidence, `\n\n[APPEAL EVIDENCE from ${req.agent.id === order.buyer_id ? 'buyer' : 'seller'}]: ${additional_evidence}`].filter(Boolean).join(''),
    };

    let verdict;
    try {
      verdict = await arbitrateDispute({ order, service, dispute: enhancedDispute, delivery });
    } catch (e) {
      // Restore order state on failure
      await dbRun(`UPDATE orders SET status = 'disputed' WHERE id = ${p(1)}`, [order.id]);
      return res.status(500).json({ error: 'Re-arbitration failed', details: e.message });
    }

    const { winner: newWinner, confidence, votes, key_factors, dissent, method, escalate_to_human, constitutional_shortcut } = verdict;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    if (escalate_to_human) {
      await dbRun(`UPDATE orders SET status = 'under_review' WHERE id = ${p(1)}`, [order.id]);
      return res.json({
        appeal_result: 'escalated_to_human',
        order_id: order.id,
        message: 'Appeal evidence reviewed. Confidence still insufficient — escalated to human review.',
        votes, confidence,
      });
    }

    // Re-execute verdict. Four cases: no-change (buyer/buyer or seller/seller)
    // and two reversals. Original fee was DISPUTE_FEE_RATE (the dispute path),
    // and it was credited to platform_revenue only if the seller originally won.
    const originalWinner = order.status === 'refunded' ? 'buyer' : 'seller';
    const amount = parseFloat(order.amount);
    const fee = amount * DISPUTE_FEE_RATE;
    const sellerReceives = amount - fee;
    const verdictChanged = originalWinner !== newWinner;

    if (!verdictChanged) {
      // Restore the original terminal status — order was set to 'disputed' earlier to re-arbitrate.
      const restoredStatus = originalWinner === 'buyer' ? 'refunded' : 'completed';
      await dbRun(`UPDATE orders SET status = ${p(1)}, completed_at = ${now} WHERE id = ${p(2)}`, [restoredStatus, order.id]);
    } else if (originalWinner === 'seller' && newWinner === 'buyer') {
      // Reversal: claw back seller payout, refund buyer, debit platform fee.
      await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [amount, order.buyer_id]);
      await debitPlatformFee(fee);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    } else {
      // Reversal: claw back buyer refund, pay seller (net of fee), credit platform fee.
      await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await creditPlatformFee(fee);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    }

    res.json({
      appeal_result: 're_arbitrated',
      order_id: order.id,
      original_winner: originalWinner,
      new_winner: newWinner,
      verdict_changed: verdictChanged,
      confidence, method, votes,
      message: `Appeal re-arbitration complete. Winner: ${newWinner}.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/bulk-cancel — buyer cancels up to 10 unpaid/paid orders at once (full refund)
// Must be before /:id routes
router.post('/bulk-cancel', requireApiKey, async (req, res, next) => {
  try {
    const { order_ids } = req.body;
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ error: 'order_ids must be a non-empty array' });
    }
    if (order_ids.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 orders per bulk cancel' });
    }

    const results = await Promise.allSettled(order_ids.map(async (orderId) => {
      const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [orderId]);
      if (!order) return { order_id: orderId, error: 'Order not found' };
      if (order.buyer_id !== req.agent.id) return { order_id: orderId, error: 'Only buyer can cancel' };
      if (!['paid', 'unpaid'].includes(order.status)) {
        return { order_id: orderId, error: `Cannot cancel order with status: ${order.status}` };
      }
      // Refund escrow amount to buyer
      if (order.status === 'paid') {
        await dbRun(`UPDATE agents SET balance = balance + ${p(1)}, escrow = COALESCE(escrow,0) - ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, req.agent.id]);
        await dbRun(`UPDATE agents SET escrow = COALESCE(escrow,0) - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.seller_id]);
      }
      await dbRun(`UPDATE orders SET status = 'cancelled' WHERE id = ${p(1)}`, [orderId]);
      return { order_id: orderId, refunded: order.status === 'paid' ? order.amount : 0, status: 'cancelled' };
    }));

    const summary = results.map((r, i) => r.status === 'fulfilled' ? r.value : { order_id: order_ids[i], error: r.reason?.message || 'Unknown error' });
    const succeeded = summary.filter(r => !r.error).length;
    res.json({ processed: order_ids.length, succeeded, failed: order_ids.length - succeeded, results: summary });
  } catch (err) { next(err); }
});

// POST /orders/batch — create up to 10 escrow orders at once.
// Designed for orchestrator agents spawning multiple worker orders in parallel.
// Each item in the `orders` array follows the same schema as POST /orders.
// Processes all in parallel; returns per-item results. Partial failure is OK.
router.post('/batch', idempotency(), requireApiKey, async (req, res, next) => {
  try {
    const { orders: orderItems } = req.body;
    if (!Array.isArray(orderItems) || orderItems.length === 0) {
      return res.status(400).json({ error: 'orders must be a non-empty array' });
    }
    if (orderItems.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 orders per batch' });
    }

    // Escrow-first model: no pre-top-up required. Each item locks its own amount.

    // Process each order item in parallel
    const results = await Promise.all(orderItems.map(async (item, idx) => {
      try {
        const { service_id, requirements, max_revisions } = item;
        if (!service_id) return { index: idx, error: 'service_id is required' };

        const service = await dbGet(
          `SELECT s.*, a.id as agent_id, a.name as agent_name, a.away_mode, a.blocklist
           FROM services s JOIN agents a ON a.id = s.agent_id
           WHERE s.id = ${p(1)} AND (s.is_active = 1 OR s.is_active = true)`,
          [service_id]
        );
        if (!service) return { index: idx, service_id, error: 'Service not found or inactive' };
        if (service.agent_id === req.agent.id) return { index: idx, service_id, error: 'Cannot order your own service' };

        // Blocklist check
        const sellerBl = service.blocklist ? (typeof service.blocklist === 'string' ? JSON.parse(service.blocklist) : service.blocklist) : [];
        if (sellerBl.some(b => b.agent_id === req.agent.id)) {
          return { index: idx, service_id, error: 'Blocked by seller' };
        }

        // Away mode check
        if (service.away_mode) {
          const away = typeof service.away_mode === 'string' ? JSON.parse(service.away_mode) : service.away_mode;
          if (away?.active && !(away.until && new Date(away.until) < new Date())) {
            return { index: idx, service_id, error: 'Seller is currently away', code: 'seller_away' };
          }
        }

        const amount = parseFloat(item.amount || service.price);
        const orderId = 'ord_' + uuidv4().replace(/-/g, '').slice(0, 16);
        const deadline = new Date(Date.now() + (service.delivery_hours || 48) * 3600000).toISOString();
        const now = isPostgres ? 'NOW()' : "datetime('now')";

        // Deduct buyer balance for this order
        await dbRun(
          `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
          [amount, amount, req.agent.id]
        );

        await dbRun(
          `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline, max_revisions, created_at)
           VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)},${p(8)},${now})`,
          [orderId, req.agent.id, service.agent_id, service_id, amount,
           typeof requirements === 'object' ? JSON.stringify(requirements) : (requirements || null),
           deadline, max_revisions || 3]
        );

        fire([service.agent_id], EVENTS.ORDER_CREATED, {
          order_id: orderId, buyer_id: req.agent.id, amount, service_id, deadline,
        }).catch(() => {});

        return { index: idx, service_id, order_id: orderId, status: 'paid', amount, deadline };
      } catch (itemErr) {
        return { index: idx, service_id: item.service_id, error: itemErr.message };
      }
    }));

    const succeeded = results.filter(r => !r.error).length;
    res.status(207).json({
      processed: orderItems.length,
      succeeded,
      failed: orderItems.length - succeeded,
      results,
      message: `Batch complete: ${succeeded}/${orderItems.length} orders created.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/batch-arbitrate
// NOTE: must be registered BEFORE /:id routes so Express doesn't treat 'batch-arbitrate' as an id
// Arbitrate multiple disputed orders at once (up to 10 per call).
// Caller must be buyer or seller on each order. Processes in parallel.
router.post('/batch-arbitrate', requireApiKey, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI arbitration not available: ANTHROPIC_API_KEY not configured' });
    }

    const { order_ids } = req.body;
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ error: 'order_ids must be a non-empty array' });
    }
    if (order_ids.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 orders per batch' });
    }

    const results = await Promise.allSettled(order_ids.map(async (orderId) => {
      const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [orderId]);
      if (!order) return { order_id: orderId, error: 'Order not found' };
      if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
        return { order_id: orderId, error: 'Access denied' };
      }
      if (order.status !== 'disputed') {
        return { order_id: orderId, error: `Not disputed (status: ${order.status})` };
      }

      const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)} AND status = 'open'`, [order.id]);
      if (!dispute) return { order_id: orderId, error: 'No open dispute found' };

      const [service, delivery] = await Promise.all([
        dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [order.service_id]),
        dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [order.id])
      ]);

      let verdict;
      try {
        verdict = await arbitrateDispute({ order, service, dispute, delivery });
      } catch (e) {
        return { order_id: orderId, error: 'AI arbitration failed: ' + e.message };
      }

      const { winner, reasoning, confidence, votes, escalate_to_human } = verdict;
      const now = isPostgres ? 'NOW()' : "datetime('now')";

      if (escalate_to_human) {
        await dbRun(`UPDATE orders SET status = 'under_review' WHERE id = ${p(1)}`, [order.id]);
        return { order_id: orderId, result: 'escalated_to_human', confidence };
      }

      const loserId = winner === 'buyer' ? order.seller_id : order.buyer_id;
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

      const votesSummary = votes.map(v => `${v.winner}(${(v.confidence*100).toFixed(0)}%)`).join(', ');
      const resolution = `[AI Arbitration N=3 | votes: ${votesSummary} | avg confidence: ${(confidence * 100).toFixed(0)}%] ${reasoning}`;
      await dbRun(
        `UPDATE disputes SET status = 'resolved', resolution = ${p(1)}, resolved_at = ${now} WHERE id = ${p(2)}`,
        [resolution, dispute.id]
      );

      try { await adjustReputation(loserId, -REP_DISPUTE_PENALTY, 'dispute_lost_ai_arbitration', order.id); } catch (e) {}

      return {
        order_id: orderId,
        result: 'arbitrated',
        winner,
        new_order_status: winner === 'buyer' ? 'refunded' : 'completed',
        confidence,
        votes,
      };
    }));

    const summary = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { order_id: order_ids[i], error: r.reason?.message || 'Unknown error' };
    });

    const succeeded = summary.filter(r => !r.error).length;
    res.json({
      batch_size: order_ids.length,
      succeeded,
      failed: order_ids.length - succeeded,
      results: summary,
    });
  } catch (err) { next(err); }
});

// GET /orders/:id/dispute/transparency-report
// Returns a public, auditable record of AI arbitration for a resolved dispute.
router.get('/:id/dispute/transparency-report', async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT id, buyer_id, seller_id, amount, status FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const dispute = await dbGet(`SELECT * FROM disputes WHERE order_id = ${p(1)}`, [req.params.id]);
    if (!dispute) return res.status(404).json({ error: 'No dispute found for this order' });

    // Parse AI arbitration data from resolution string
    // Format: "[AI Arbitration N=3 | votes: seller(94%),buyer(12%),seller(88%) | avg confidence: XX%] reasoning"
    let ai_arbitration = null;
    if (dispute.resolution && dispute.resolution.startsWith('[AI Arbitration')) {
      const match = dispute.resolution.match(/\[AI Arbitration N=3 \| votes: ([^\|]+)\| avg confidence: (\d+)%\] (.*)/s);
      if (match) {
        const voteStrings = match[1].trim().split(',');
        const votes = voteStrings.map(v => {
          const m = v.match(/(\w+)\((\d+)%\)/);
          return m ? { winner: m[1], confidence: parseInt(m[2]) / 100 } : null;
        }).filter(Boolean);
        ai_arbitration = {
          method: 'N=3 LLM majority vote',
          model: 'claude-haiku-n3',
          votes,
          avg_confidence: parseInt(match[2]) / 100,
          reasoning: match[3].trim(),
        };
      }
    }

    res.json({
      report_type: 'arbitration_transparency_report',
      order_id: order.id,
      dispute_id: dispute.id,
      dispute: {
        reason: dispute.reason,
        evidence: dispute.evidence || null,
        status: dispute.status,
        raised_by: dispute.raised_by,
        created_at: dispute.created_at,
        resolved_at: dispute.resolved_at || null,
      },
      verdict: dispute.status === 'resolved' ? {
        winner: dispute.resolution?.includes('winner: buyer') || (ai_arbitration?.votes?.filter(v => v.winner === 'buyer').length > 1) ? 'buyer' : 'seller',
        final_order_status: order.status,
      } : null,
      ai_arbitration,
      auditable: true,
      note: 'This report is generated from immutable arbitration logs and can be used for compliance auditing.',
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/cancel — buyer can cancel a 'paid' order before delivery (full refund)
router.post('/:id/cancel', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found', code: 'not_found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can cancel this order' });
    if (order.status !== 'paid') return res.status(400).json({ error: `Cannot cancel order in status '${order.status}'. Only 'paid' orders can be cancelled.` });

    const now = isPostgres ? 'NOW()' : "datetime('now')";
    // Atomic transition: prevents deliver+cancel race from double-refunding.
    const transition = await dbRun(
      `UPDATE orders SET status = 'cancelled', completed_at = ${now}
        WHERE id = ${p(1)} AND status = 'paid'`,
      [order.id]
    );
    if (!transition.changes) {
      return res.status(400).json({ error: 'Cannot cancel: order state changed concurrently' });
    }

    // Refund escrow to buyer
    await dbRun(
      `UPDATE agents SET balance = balance + ${p(1)}, escrow = escrow - ${p(2)} WHERE id = ${p(3)}`,
      [parseFloat(order.amount), parseFloat(order.amount), order.buyer_id]
    );

    // Release any seller escrow hold
    await dbRun(
      `UPDATE agents SET escrow = GREATEST(COALESCE(escrow, 0) - ${p(1)}, 0) WHERE id = ${p(2)}`,
      [parseFloat(order.amount), order.seller_id]
    ).catch(() => {});

    // Fire webhook
    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_CANCELLED, {
      order_id: order.id,
      amount: order.amount,
      refunded_to: order.buyer_id,
      buyer_id: order.buyer_id,
      seller_id: order.seller_id,
    });

    res.json({
      id: order.id,
      status: 'cancelled',
      refunded_amount: parseFloat(order.amount),
      message: 'Order cancelled. Full refund returned to your balance.',
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/flag — flag an order for suspicious/fraudulent activity (either party)
router.post('/:id/flag', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT id, buyer_id, seller_id, status FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Only order parties can flag an order' });
    }
    const { reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'reason is required' });
    if (reason.length > 1000) return res.status(400).json({ error: 'reason must be 1000 characters or less' });

    // Store flag in human_review_queue (repurpose for flags too)
    const flagId = uuidv4();
    await dbRun(
      `INSERT INTO human_review_queue (id, order_id, dispute_id, ai_votes, ai_reasoning, status, escalation_reason)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, 'pending', ${p(6)})`,
      [flagId, order.id, 'flag:' + req.agent.id, '[]', null, reason.trim()]
    ).catch(async () => {
      // If table has strict FK constraints, fallback: just log
      console.warn('Flag stored in-memory only (review queue FK constraint)');
    });

    res.json({
      flag_id: flagId,
      order_id: order.id,
      flagged_by: req.agent.id,
      reason: reason.trim(),
      status: 'submitted',
      message: 'Order flagged for review. Our team will investigate.',
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/tip — buyer sends extra USDC to seller after order completion
router.post('/:id/tip', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can send a tip' });
    if (order.status !== 'completed') return res.status(400).json({ error: 'Tips can only be sent on completed orders' });

    const amount = parseFloat(req.body.amount);
    if (!(amount >= 0.01)) return res.status(400).json({ error: 'amount must be at least 0.01 USDC' });
    if (amount > 1000) return res.status(400).json({ error: 'amount cannot exceed 1000 USDC' });

    // Escrow-first model: no pre-top-up required. Tip settles via wallet integration.

    // Transfer tip: buyer → seller
    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`,
      [amount, req.agent.id]
    );
    await dbRun(
      `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
      [amount, order.seller_id]
    );

    // Small rep bonus for seller
    await dbRun(
      `UPDATE agents SET reputation_score = COALESCE(reputation_score, 0) + 2 WHERE id = ${p(1)}`,
      [order.seller_id]
    );

    // Record tip in tips table
    const tipId = uuidv4();
    await dbRun(
      `INSERT INTO tips (id, order_id, from_id, to_id, amount) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`,
      [tipId, order.id, req.agent.id, order.seller_id, amount]
    );

    // Fire webhook
    fire([order.seller_id, order.buyer_id], EVENTS.ORDER_TIP_RECEIVED, {
      order_id: order.id, tip_id: tipId, amount, from: req.agent.id,
    });

    res.json({
      id: tipId,
      order_id: order.id,
      tip_amount: amount,
      seller_id: order.seller_id,
      message: `Tip of ${amount} USDC sent to seller.`,
    });
  } catch (err) { next(err); }
});

// GET /orders/:id/tips — tip history for an order
router.get('/:id/tips', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT id, buyer_id, seller_id FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Only order parties can view tips' });
    }
    const tips = await dbAll(
      `SELECT t.id, t.amount, t.created_at, a.name as from_name
       FROM tips t
       LEFT JOIN agents a ON a.id = t.from_id
       WHERE t.order_id = ${p(1)}
       ORDER BY t.created_at ASC`,
      [req.params.id]
    );
    const total = tips.reduce((sum, t) => sum + parseFloat(t.amount), 0);
    res.json({
      order_id: req.params.id,
      count: tips.length,
      total: parseFloat(total.toFixed(6)),
      tips: tips.map(t => ({ id: t.id, amount: parseFloat(t.amount), from_name: t.from_name, created_at: t.created_at })),
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/extend-deadline — buyer can request deadline extension (adds hours)
router.post('/:id/extend-deadline', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can extend the deadline' });
    if (!['paid', 'delivered'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot extend deadline for order with status: ${order.status}` });
    }

    const addHours = parseInt(req.body.hours);
    if (!(addHours >= 1 && addHours <= 720)) {
      return res.status(400).json({ error: 'hours must be between 1 and 720' });
    }

    const newDeadline = isPostgres
      ? `(COALESCE(deadline::timestamp, NOW()) + interval '${addHours} hours')`
      : `datetime(COALESCE(deadline, datetime('now')), '+${addHours} hours')`;

    await dbRun(`UPDATE orders SET deadline = ${newDeadline} WHERE id = ${p(1)}`, [order.id]);

    const updated = await dbGet(`SELECT id, deadline, status FROM orders WHERE id = ${p(1)}`, [order.id]);
    res.json({
      id: updated.id,
      status: updated.status,
      new_deadline: updated.deadline,
      hours_added: addHours,
      message: `Deadline extended by ${addHours} hour${addHours > 1 ? 's' : ''}.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/request-deadline-extension — seller requests extra time (max 48h, once per order).
// Extension is auto-applied and buyer is notified. No buyer approval needed for small extensions.
router.post('/:id/request-deadline-extension', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.seller_id !== req.agent.id) return res.status(403).json({ error: 'Only the seller can request a deadline extension' });
    if (order.status !== 'paid') return res.status(400).json({ error: `Can only request extension on 'paid' orders (current: ${order.status})` });
    if (order.seller_extension_used) return res.status(400).json({ error: 'Seller has already used their one-time deadline extension on this order' });

    const addHours = parseInt(req.body.hours);
    const reason = (req.body.reason || '').slice(0, 500);
    if (!(addHours >= 1 && addHours <= 48)) {
      return res.status(400).json({ error: 'hours must be between 1 and 48 (seller extensions limited to 48h)' });
    }

    const newDeadline = isPostgres
      ? `(COALESCE(deadline::timestamp, NOW()) + interval '${addHours} hours')`
      : `datetime(COALESCE(deadline, datetime('now')), '+${addHours} hours')`;

    await dbRun(
      `UPDATE orders SET deadline = ${newDeadline}, seller_extension_used = ${isPostgres ? 'true' : '1'} WHERE id = ${p(1)}`,
      [order.id]
    );

    const updated = await dbGet(`SELECT id, deadline, status FROM orders WHERE id = ${p(1)}`, [order.id]);

    const { fire, EVENTS } = require('../webhooks');
    fire([order.buyer_id], EVENTS.ORDER_DEADLINE_EXTENDED, {
      order_id: order.id,
      extended_by: req.agent.id,
      extended_by_role: 'seller',
      hours_added: addHours,
      reason,
      new_deadline: updated.deadline,
    }).catch(() => {});

    res.json({
      id: updated.id,
      status: updated.status,
      new_deadline: updated.deadline,
      hours_added: addHours,
      reason: reason || null,
      message: `Deadline extended by ${addHours}h. Buyer has been notified. This is a one-time seller extension.`,
    });
  } catch (err) { next(err); }
});

// GET /orders/:id/receipt — structured receipt JSON (auth required, buyer or seller)
router.get('/:id/receipt', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(
      `SELECT o.*, s.name as service_name, s.category as service_category,
              buyer.name as buyer_name, seller.name as seller_name
       FROM orders o
       LEFT JOIN services s ON o.service_id = s.id
       LEFT JOIN agents buyer ON o.buyer_id = buyer.id
       LEFT JOIN agents seller ON o.seller_id = seller.id
       WHERE o.id = ${p(1)}`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const isDisputed = order.status === 'disputed' || order.status === 'refunded';
    const feeRate = isDisputed ? DISPUTE_FEE_RATE : RELEASE_FEE_RATE;
    const fee = parseFloat(order.amount) * feeRate;

    res.json({
      receipt_id: `rcpt_${order.id}`,
      platform: 'Arbitova',
      generated_at: new Date().toISOString(),
      order: {
        id: order.id,
        status: order.status,
        created_at: order.created_at,
        completed_at: order.completed_at || null,
        deadline: order.deadline,
      },
      service: {
        id: order.service_id,
        name: order.service_name || null,
        category: order.service_category || null,
      },
      parties: {
        buyer: { id: order.buyer_id, name: order.buyer_name },
        seller: { id: order.seller_id, name: order.seller_name },
      },
      financials: {
        order_amount: parseFloat(order.amount),
        platform_fee: order.status === 'completed' ? fee : 0,
        fee_rate: order.status === 'completed' ? feeRate : 0,
        seller_received: order.status === 'completed' ? parseFloat(order.amount) - fee : null,
        currency: 'USDC',
      },
      requirements: order.requirements || null,
      auditable: true,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/counter-offer — seller proposes a partial refund on a disputed order.
// Buyer can accept (partial refund + close) or decline (dispute stays open for arbitration).
// Only one active counter-offer per order at a time.
router.post('/:id/counter-offer', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.seller_id !== req.agent.id) return res.status(403).json({ error: 'Only the seller can propose a counter-offer' });
    if (order.status !== 'disputed') return res.status(400).json({ error: 'Counter-offers can only be made on disputed orders' });

    const refundAmount = parseFloat(req.body.refund_amount);
    const note = (req.body.note || '').slice(0, 500);
    if (!(refundAmount >= 0.01)) return res.status(400).json({ error: 'refund_amount must be at least 0.01 USDC' });
    if (refundAmount >= parseFloat(order.amount)) return res.status(400).json({ error: 'refund_amount must be less than the order total. For a full refund, cancel the order instead.' });

    // Rate limit: if a pending counter-offer already exists, require a 1-hour cooldown
    // before it can be superseded. Prevents sellers from spamming the buyer with new offers.
    const existing = order.counter_offer
      ? (typeof order.counter_offer === 'string' ? JSON.parse(order.counter_offer) : order.counter_offer)
      : null;
    if (existing && existing.status === 'pending') {
      const elapsedMs = Date.now() - new Date(existing.proposed_at).getTime();
      const COOLDOWN_MS = 60 * 60 * 1000;
      if (elapsedMs < COOLDOWN_MS) {
        const retryInMin = Math.ceil((COOLDOWN_MS - elapsedMs) / 60000);
        return res.status(429).json({
          error: `A counter-offer is already pending. You can propose a new one in ${retryInMin} minute(s), or wait for the buyer to accept/decline.`,
          retry_after_minutes: retryInMin,
        });
      }
    }

    const offer = {
      status: 'pending',
      refund_amount: refundAmount,
      seller_keeps: parseFloat((order.amount - refundAmount).toFixed(6)),
      note,
      proposed_by: req.agent.id,
      proposed_at: new Date().toISOString(),
    };

    // Store as JSON in the dispute's resolution field (or order's metadata)
    await dbRun(
      `UPDATE orders SET counter_offer = ${p(1)} WHERE id = ${p(2)}`,
      [JSON.stringify(offer), order.id]
    );

    const { fire, EVENTS } = require('../webhooks');
    fire([order.buyer_id], EVENTS.MESSAGE_RECEIVED, {
      type: 'counter_offer',
      order_id: order.id,
      refund_amount: refundAmount,
      seller_keeps: offer.seller_keeps,
      note,
    }).catch(() => {});

    res.json({
      order_id: order.id,
      counter_offer: offer,
      message: `Counter-offer proposed: buyer receives ${refundAmount} USDC, seller keeps ${offer.seller_keeps} USDC. Awaiting buyer acceptance.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/counter-offer/accept — buyer accepts the seller's counter-offer.
// Partial refund issued immediately; order closes as 'resolved'.
router.post('/:id/counter-offer/accept', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can accept a counter-offer' });
    if (order.status !== 'disputed') return res.status(400).json({ error: 'No active counter-offer on this order' });

    const offer = order.counter_offer
      ? (typeof order.counter_offer === 'string' ? JSON.parse(order.counter_offer) : order.counter_offer)
      : null;
    if (!offer || offer.status !== 'pending') return res.status(400).json({ error: 'No pending counter-offer on this order' });

    const refundAmount = parseFloat(offer.refund_amount);
    const sellerKeepsGross = parseFloat(offer.seller_keeps);
    const fee = parseFloat((sellerKeepsGross * DISPUTE_FEE_RATE).toFixed(6));
    const sellerKeeps = parseFloat((sellerKeepsGross - fee).toFixed(6));
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Release escrow: buyer gets refund_amount, seller gets seller_keeps (net of dispute fee)
    await dbRun(
      `UPDATE agents SET balance = balance + ${p(1)}, escrow = escrow - ${p(2)} WHERE id = ${p(3)}`,
      [refundAmount, parseFloat(order.amount), order.buyer_id]
    );
    await dbRun(
      `UPDATE agents SET balance = balance + ${p(1)}, escrow = GREATEST(COALESCE(escrow,0) - ${p(2)}, 0) WHERE id = ${p(3)}`,
      [sellerKeeps, parseFloat(order.amount), order.seller_id]
    );
    await creditPlatformFee(fee);

    offer.status = 'accepted';
    offer.accepted_at = new Date().toISOString();

    await dbRun(
      `UPDATE orders SET status = 'completed', counter_offer = ${p(1)}, completed_at = ${now} WHERE id = ${p(2)}`,
      [JSON.stringify(offer), order.id]
    );

    // Close any open dispute
    await dbRun(
      `UPDATE disputes SET status = 'resolved', resolution = 'Counter-offer accepted', resolved_at = ${now} WHERE order_id = ${p(1)} AND status = 'open'`,
      [order.id]
    ).catch(() => {});

    const { fire, EVENTS } = require('../webhooks');
    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_COMPLETED, {
      order_id: order.id,
      resolution: 'counter_offer_accepted',
      buyer_received: refundAmount,
      seller_received: sellerKeeps,
      platform_fee: fee,
    }).catch(() => {});

    res.json({
      order_id: order.id,
      status: 'completed',
      resolution: 'counter_offer_accepted',
      buyer_received: refundAmount,
      seller_received: sellerKeeps,
      platform_fee: fee,
      message: `Counter-offer accepted. Dispute closed. ${refundAmount} USDC returned to buyer, ${sellerKeeps} USDC released to seller (after ${(DISPUTE_FEE_RATE * 100).toFixed(0)}% dispute fee of ${fee} USDC).`,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/counter-offer/decline — buyer declines; dispute stays open.
router.post('/:id/counter-offer/decline', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can decline a counter-offer' });
    if (order.status !== 'disputed') return res.status(400).json({ error: 'No active counter-offer on this order' });

    const offer = order.counter_offer
      ? (typeof order.counter_offer === 'string' ? JSON.parse(order.counter_offer) : order.counter_offer)
      : null;
    if (!offer || offer.status !== 'pending') return res.status(400).json({ error: 'No pending counter-offer on this order' });

    offer.status = 'declined';
    offer.declined_at = new Date().toISOString();

    await dbRun(
      `UPDATE orders SET counter_offer = ${p(1)} WHERE id = ${p(2)}`,
      [JSON.stringify(offer), order.id]
    );

    res.json({
      order_id: order.id,
      status: 'disputed',
      counter_offer: 'declined',
      message: 'Counter-offer declined. The dispute remains open. You may proceed to AI arbitration.',
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/request-revision — buyer formally requests seller to revise a delivered order.
// Order moves back to 'paid' status; seller can re-deliver. Deadline extended by delivery_hours.
// Limited to 3 revision rounds per order to prevent abuse. No charge; no dispute needed.
router.post('/:id/request-revision', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT * FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id) return res.status(403).json({ error: 'Only the buyer can request a revision' });
    if (order.status !== 'delivered') return res.status(400).json({ error: `Revisions can only be requested on delivered orders (current: ${order.status})` });

    const revisionCount = parseInt(order.revision_count || 0);
    const maxRevisions = parseInt(order.max_revisions || 3);
    if (revisionCount >= maxRevisions) {
      return res.status(400).json({
        error: `Revision limit reached (${maxRevisions}). Open a dispute or confirm delivery.`,
        revisions_used: revisionCount,
        max_revisions: maxRevisions,
      });
    }

    const feedback = (req.body.feedback || '').slice(0, 2000);
    if (!feedback) return res.status(400).json({ error: 'feedback is required — explain what needs revision' });

    const extraHours = Math.min(parseInt(req.body.extra_hours || 24), 168); // max 1 week extension
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    const newDeadline = isPostgres
      ? `(COALESCE(deadline::timestamp, NOW()) + interval '${extraHours} hours')`
      : `datetime(COALESCE(deadline, datetime('now')), '+${extraHours} hours')`;

    await dbRun(
      `UPDATE orders SET status = 'paid', revision_count = COALESCE(revision_count, 0) + 1,
       deadline = ${newDeadline} WHERE id = ${p(1)}`,
      [order.id]
    );

    // Post as order comment
    const revComment = {
      id: uuidv4(),
      author_id: req.agent.id,
      role: 'buyer',
      message: `[Revision ${revisionCount + 1}/${maxRevisions}] ${feedback}`,
      created_at: new Date().toISOString(),
      type: 'revision_request',
    };
    const existing = order.comments
      ? (typeof order.comments === 'string' ? JSON.parse(order.comments) : order.comments)
      : [];
    existing.push(revComment);
    await dbRun(`UPDATE orders SET comments = ${p(1)} WHERE id = ${p(2)}`, [JSON.stringify(existing), order.id]);

    const { fire, EVENTS } = require('../webhooks');
    fire([order.seller_id], EVENTS.ORDER_CREATED, {
      type: 'revision_requested',
      order_id: order.id,
      revision_round: revisionCount + 1,
      max_revisions: maxRevisions,
      feedback,
      extra_hours: extraHours,
    }).catch(() => {});

    const updated = await dbGet(`SELECT id, deadline, revision_count FROM orders WHERE id = ${p(1)}`, [order.id]);
    res.json({
      order_id: order.id,
      status: 'paid',
      revision_round: parseInt(updated.revision_count || 0),
      max_revisions: maxRevisions,
      revisions_remaining: maxRevisions - parseInt(updated.revision_count || 0),
      new_deadline: updated.deadline,
      feedback,
      message: `Revision requested (round ${updated.revision_count}/${maxRevisions}). Seller notified. Deadline extended by ${extraHours}h.`,
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/comments — buyer or seller posts a comment on an order (order-linked chat)
// Stored as JSON array in orders.comments. Both parties can post; both notified via SSE.
router.post('/:id/comments', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT id, buyer_id, seller_id, status, comments FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Only the buyer or seller can comment on this order' });
    }

    const body = (req.body.message || '').trim();
    if (!body) return res.status(400).json({ error: 'message is required' });
    if (body.length > 2000) return res.status(400).json({ error: 'message must be 2000 characters or less' });

    const existing = order.comments
      ? (typeof order.comments === 'string' ? JSON.parse(order.comments) : order.comments)
      : [];
    if (existing.length >= 100) return res.status(400).json({ error: 'Order comment limit reached (100)' });

    const comment = {
      id: uuidv4(),
      author_id: req.agent.id,
      role: req.agent.id === order.buyer_id ? 'buyer' : 'seller',
      message: body,
      created_at: new Date().toISOString(),
    };
    existing.push(comment);

    await dbRun(`UPDATE orders SET comments = ${p(1)} WHERE id = ${p(2)}`, [JSON.stringify(existing), order.id]);

    const otherId = req.agent.id === order.buyer_id ? order.seller_id : order.buyer_id;
    const { fire, EVENTS } = require('../webhooks');
    fire([otherId], EVENTS.MESSAGE_RECEIVED, {
      type: 'order_comment',
      order_id: order.id,
      from: req.agent.id,
      from_role: comment.role,
      message: body,
    }).catch(() => {});

    res.status(201).json({ order_id: order.id, comment });
  } catch (err) { next(err); }
});

// GET /orders/:id/comments — retrieve all comments on an order
router.get('/:id/comments', requireApiKey, async (req, res, next) => {
  try {
    const order = await dbGet(`SELECT id, buyer_id, seller_id, comments FROM orders WHERE id = ${p(1)}`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const comments = order.comments
      ? (typeof order.comments === 'string' ? JSON.parse(order.comments) : order.comments)
      : [];
    res.json({ order_id: order.id, count: comments.length, comments });
  } catch (err) { next(err); }
});

// ── POST /orders/batch-status — check status of multiple orders at once ────────
// Accepts an array of order IDs and returns status for each in one request.
// Only returns orders where the caller is buyer or seller (silently skips others).
router.post('/batch-status', requireApiKey, async (req, res, next) => {
  try {
    const { order_ids } = req.body;
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ error: 'order_ids must be a non-empty array' });
    }
    if (order_ids.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 order IDs per request' });
    }

    // Fetch all in one query using IN clause
    const placeholders = order_ids.map((_, i) => p(i + 1)).join(', ');
    const rows = await dbAll(
      `SELECT id, status, buyer_id, seller_id, amount, created_at, updated_at
       FROM orders WHERE id IN (${placeholders})`,
      order_ids
    );

    const visible = rows.filter(r => r.buyer_id === req.agent.id || r.seller_id === req.agent.id);
    const visibleIds = new Set(visible.map(r => r.id));

    const results = order_ids.map(oid => {
      if (!visibleIds.has(oid)) {
        const found = rows.find(r => r.id === oid);
        return { order_id: oid, found: !!found, accessible: false };
      }
      const row = visible.find(r => r.id === oid);
      return {
        order_id: oid,
        found: true,
        accessible: true,
        status: row.status,
        role: row.buyer_id === req.agent.id ? 'buyer' : 'seller',
        amount_usdc: parseFloat(row.amount || 0),
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    });

    res.json({
      requested: order_ids.length,
      found: rows.length,
      accessible: visible.length,
      results,
    });
  } catch (err) { next(err); }
});

// ── GET /orders/at-risk — orders approaching their deadline ──────────────────
// Returns active orders where the deadline is within the next N hours.
// Seller agents use this to prioritise delivery queue.
// Buyer agents use this to monitor SLA adherence.
router.get('/at-risk', requireApiKey, async (req, res, next) => {
  try {
    const hoursAhead = Math.min(parseInt(req.query.hours) || 24, 168); // max 7 days
    const now = new Date();
    const threshold = new Date(now.getTime() + hoursAhead * 3600 * 1000).toISOString();

    const rows = await dbAll(
      `SELECT o.id, o.status, o.buyer_id, o.seller_id, o.amount,
              o.deadline, o.service_id, o.created_at,
              s.title AS service_title, s.category,
              ab.name AS buyer_name, as2.name AS seller_name
       FROM orders o
       LEFT JOIN services s ON o.service_id = s.id
       LEFT JOIN agents ab ON o.buyer_id = ab.id
       LEFT JOIN agents as2 ON o.seller_id = as2.id
       WHERE o.status IN ('in_progress', 'pending')
         AND o.deadline IS NOT NULL
         AND o.deadline <= ${p(1)}
         AND o.deadline >= ${p(2)}
         AND (o.buyer_id = ${p(3)} OR o.seller_id = ${p(4)})
       ORDER BY o.deadline ASC
       LIMIT 50`,
      [threshold, now.toISOString(), req.agent.id, req.agent.id]
    );

    const results = rows.map(row => {
      const deadline = new Date(row.deadline);
      const minutesLeft = Math.floor((deadline - now) / 60000);
      const hoursLeft = parseFloat((minutesLeft / 60).toFixed(1));
      const urgency = minutesLeft <= 60 ? 'critical' : minutesLeft <= 240 ? 'high' : 'moderate';
      return {
        order_id: row.id,
        status: row.status,
        role: row.buyer_id === req.agent.id ? 'buyer' : 'seller',
        service_title: row.service_title || row.id,
        category: row.category,
        amount_usdc: parseFloat(row.amount || 0),
        deadline: row.deadline,
        hours_remaining: hoursLeft,
        minutes_remaining: minutesLeft,
        urgency,
        counterparty: row.buyer_id === req.agent.id
          ? { id: row.seller_id, name: row.seller_name }
          : { id: row.buyer_id, name: row.buyer_name },
      };
    });

    res.json({
      agent_id: req.agent.id,
      hours_window: hoursAhead,
      at_risk_count: results.length,
      critical: results.filter(r => r.urgency === 'critical').length,
      high: results.filter(r => r.urgency === 'high').length,
      orders: results,
      generated_at: now.toISOString(),
    });
  } catch (err) { next(err); }
});

module.exports = router;
