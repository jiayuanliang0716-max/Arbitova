const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun, dbTransaction } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
const { verifyInput, verifyDelivery } = require('../verify');
const { arbitrateDispute } = require('../arbitrate');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const PLATFORM_FEE_RATE = 0.025;
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
}

// POST /orders
router.post('/', requireApiKey, async (req, res, next) => {
  try {
    const { service_id, requirements } = req.body;
    if (!service_id) return res.status(400).json({ error: 'service_id is required' });

    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)} AND ${activeCheck}`, [service_id]);
    if (!service) return res.status(404).json({ error: 'Service not found or inactive' });
    if (service.agent_id === req.agent.id) return res.status(400).json({ error: 'Cannot purchase your own service' });

    // Validate requirements against the service's input_schema (if declared)
    if (service.input_schema) {
      const v = verifyInput(service, requirements);
      if (!v.ok) {
        return res.status(400).json({ error: 'Requirements do not satisfy service input_schema', details: v.errors });
      }
    }

    // Enforce min_seller_stake (seller must have enough stake locked)
    if (parseFloat(service.min_seller_stake || 0) > 0) {
      const seller = await dbGet(`SELECT stake FROM agents WHERE id = ${p(1)}`, [service.agent_id]);
      if (parseFloat(seller?.stake || 0) < parseFloat(service.min_seller_stake)) {
        return res.status(400).json({ error: 'Seller stake below service requirement' });
      }
    }

    const buyer = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(buyer.balance) < parseFloat(service.price)) {
      return res.status(400).json({ error: 'Insufficient balance', balance: buyer.balance, required: service.price });
    }

    const deadline = new Date();
    deadline.setHours(deadline.getHours() + service.delivery_hours);
    const orderId = uuidv4();

    await dbTransaction(async (tx) => {
      await (tx || { run: dbRun }).run
        ? tx.run(`UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`, [service.price, service.price, req.agent.id])
        : dbRun(`UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`, [service.price, service.price, req.agent.id]);

      await (tx?.run || dbRun)(
        `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)})`,
        [orderId, req.agent.id, service.agent_id, service_id, service.price, requirements || null, deadline.toISOString()]
      );
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
router.post('/bundle', requireApiKey, async (req, res, next) => {
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

      if (svc.input_schema) {
        const v = verifyInput(svc, item.requirements);
        if (!v.ok) return res.status(400).json({ error: `Requirements invalid for service ${svc.id}`, details: v.errors });
      }
      if (parseFloat(svc.min_seller_stake || 0) > 0) {
        const seller = await dbGet(`SELECT stake FROM agents WHERE id = ${p(1)}`, [svc.agent_id]);
        if (parseFloat(seller?.stake || 0) < parseFloat(svc.min_seller_stake)) {
          return res.status(400).json({ error: `Seller ${svc.agent_id} stake below requirement` });
        }
      }
      totalAmount += parseFloat(svc.price);
      resolved.push({ svc, requirements: item.requirements || null });
    }

    // Balance check for the full bundle (all-or-nothing)
    const buyer = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [req.agent.id]);
    if (parseFloat(buyer.balance) < totalAmount) {
      return res.status(400).json({ error: 'Insufficient balance for bundle', balance: buyer.balance, required: totalAmount });
    }

    const bundleId = uuidv4();
    await dbRun(
      `INSERT INTO order_bundles (id, buyer_id, total_amount, status) VALUES (${p(1)},${p(2)},${p(3)},${p(4)})`,
      [bundleId, req.agent.id, totalAmount, 'active']
    );

    // Lock total escrow once, then create each order row
    await dbRun(
      `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
      [totalAmount, totalAmount, req.agent.id]
    );

    const childIds = [];
    for (const { svc, requirements } of resolved) {
      const orderId = uuidv4();
      const deadline = new Date();
      deadline.setHours(deadline.getHours() + svc.delivery_hours);
      await dbRun(
        `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, bundle_id, deadline)
         VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)},${p(8)})`,
        [orderId, req.agent.id, svc.agent_id, svc.id, svc.price, requirements, bundleId, deadline.toISOString()]
      );
      childIds.push(orderId);
    }

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
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.buyer_id !== req.agent.id && order.seller_id !== req.agent.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const delivery = await dbGet(`SELECT * FROM deliveries WHERE order_id = ${p(1)}`, [req.params.id]);
    res.json({ ...order, delivery: delivery || null });
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

    // Load the service contract
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [order.service_id]);

    // Run output verification if contract declared
    const hasContract = !!(service && (service.output_schema || service.verification_rules));
    const verification = hasContract ? verifyDelivery(service, content) : { ok: true, stage: null, errors: [] };

    if (hasContract && !verification.ok) {
      // Auto-reject: refund buyer, mark delivery failed, penalize seller rep
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      try { await adjustReputation(order.seller_id, -REP_DISPUTE_PENALTY, 'auto_verification_failed', order.id); } catch (e) {}
      return res.status(400).json({
        order_id: order.id,
        status: 'refunded',
        verification_failed: true,
        stage: verification.stage,
        errors: verification.errors,
        message: 'Delivery rejected by automatic verification. Buyer refunded; seller reputation penalized.'
      });
    }

    const deliveryId = uuidv4();
    await dbRun(`INSERT INTO deliveries (id, order_id, content) VALUES (${p(1)},${p(2)},${p(3)})`, [deliveryId, order.id, content]);

    // If service has auto_verify and output verification passed, auto-complete immediately
    const autoVerify = service && (service.auto_verify === true || service.auto_verify === 1);
    if (hasContract && autoVerify && verification.ok) {
      const fee = parseFloat(order.amount) * PLATFORM_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      try { await adjustReputation(order.seller_id, REP_CONFIRM_BONUS, 'auto_verified_completion', order.id); } catch (e) {}
      return res.json({
        delivery_id: deliveryId,
        order_id: order.id,
        status: 'completed',
        auto_verified: true,
        platform_fee: fee.toFixed(4),
        seller_received: sellerReceives.toFixed(4),
        message: 'Delivery passed automatic verification. Funds released.'
      });
    }

    // Subscription content orders: auto-complete (payment already settled) + write inbox message
    if (order.subscription_id) {
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      const service = await dbRun(`SELECT name FROM services WHERE id = ${p(1)}`, [order.service_id]).catch(() => null);
      const msgId = uuidv4();
      const subject = order.requirements || 'Subscription Update';
      await dbRun(
        `INSERT INTO messages (id, recipient_id, sender_id, subject, body, order_id, subscription_id)
         VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})`,
        [msgId, order.buyer_id, order.seller_id, subject, content, order.id, order.subscription_id]
      );
      return res.json({
        delivery_id: deliveryId,
        order_id: order.id,
        status: 'completed',
        message_id: msgId,
        message: 'Subscription delivery complete. Message sent to buyer inbox.'
      });
    }

    await dbRun(`UPDATE orders SET status = 'delivered' WHERE id = ${p(1)}`, [order.id]);
    res.json({
      delivery_id: deliveryId,
      order_id: order.id,
      status: 'delivered',
      auto_verified: hasContract && verification.ok ? 'eligible_but_manual' : false,
      message: 'Delivery submitted. Buyer has 24 hours to confirm or dispute.'
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

    const fee = parseFloat(order.amount) * PLATFORM_FEE_RATE;
    const sellerReceives = parseFloat(order.amount) - fee;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
    await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);

    // Reputation: successful delivery confirmed by buyer
    try { await adjustReputation(order.seller_id, REP_CONFIRM_BONUS, 'order_completed', order.id); } catch (e) { console.error('rep err:', e.message); }

    res.json({
      order_id: order.id, status: 'completed',
      amount_paid: order.amount,
      platform_fee: fee.toFixed(4),
      seller_received: sellerReceives.toFixed(4),
      message: 'Transaction completed successfully.'
    });
  } catch (err) { next(err); }
});

// POST /orders/:id/dispute
router.post('/:id/dispute', requireApiKey, async (req, res, next) => {
  try {
    const { reason, evidence } = req.body;
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

    const disputeId = uuidv4();
    await dbRun(
      `INSERT INTO disputes (id, order_id, raised_by, reason, evidence) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
      [disputeId, order.id, req.agent.id, reason, evidence || null]
    );
    await dbRun(`UPDATE orders SET status = 'disputed' WHERE id = ${p(1)}`, [order.id]);

    res.status(201).json({
      dispute_id: disputeId, order_id: order.id, status: 'open',
      message: 'Dispute opened. Funds remain locked. A human arbitrator will review within 24 hours.'
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
      // Pay seller (net of platform fee)
      const fee = parseFloat(order.amount) * PLATFORM_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
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

    // Validate input schema if declared
    if (subService.input_schema) {
      const v = verifyInput(subService, requirements);
      if (!v.ok) return res.status(400).json({ error: 'Requirements do not satisfy sub-service input_schema', details: v.errors });
    }

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

    // Run AI arbitration
    let verdict;
    try {
      verdict = await arbitrateDispute({ order, service, dispute, delivery });
    } catch (e) {
      return res.status(500).json({ error: 'AI arbitration failed', details: e.message });
    }

    const { winner, reasoning, confidence } = verdict;
    const loserId = winner === 'buyer' ? order.seller_id : order.buyer_id;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Execute the verdict
    if (winner === 'buyer') {
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    } else {
      const fee = parseFloat(order.amount) * PLATFORM_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    }

    const resolution = `[AI Arbitration | confidence: ${(confidence * 100).toFixed(0)}%] ${reasoning}`;
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

    res.json({
      order_id: order.id,
      dispute_id: dispute.id,
      winner,
      loser_id: loserId,
      new_order_status: winner === 'buyer' ? 'refunded' : 'completed',
      ai_reasoning: reasoning,
      confidence,
      reputation_penalty: REP_DISPUTE_PENALTY,
      stake_slashed: slashed,
      arbitrated_by: 'claude-haiku'
    });
  } catch (err) { next(err); }
});

module.exports = router;
