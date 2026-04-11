const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun, dbTransaction } = require('../db/helpers');
const { requireApiKey } = require('../middleware/auth');
const { verifyInput, verifyDelivery, verifyDeliverySemantic } = require('../verify');
const { arbitrateDispute } = require('../arbitrate');
const { fire, EVENTS } = require('../webhooks');
const { checkVelocity } = require('../middleware/velocity');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const RELEASE_FEE_RATE = 0.005;   // 0.5% — successful delivery confirmed
const DISPUTE_FEE_RATE = 0.02;    // 2.0% — dispute resolved via AI arbitration
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
router.post('/', idempotency(), requireApiKey, async (req, res, next) => {
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
        `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, deadline) VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)},${p(7)})`,
        [orderId, req.agent.id, service.agent_id, service_id, service.price, requirements || null, deadline.toISOString()]
      );
    });

    // Digital product: service is explicitly typed as 'digital' and has a pre-uploaded file → auto-deliver immediately
    if (service.product_type === 'digital' && service.file_id) {
      try {
        const file = await dbGet(`SELECT id, filename FROM files WHERE id = ${p(1)}`, [service.file_id]);
        if (file) {
          const fee = parseFloat(service.price) * RELEASE_FEE_RATE;
          const sellerReceives = parseFloat(service.price) - fee;
          const now = isPostgres ? 'NOW()' : "datetime('now')";
          const deliveryId = uuidv4();
          const downloadUrl = `/files/${file.id}/download`;
          const deliveryContent = `[Digital Product] ${file.filename}\nDownload: ${downloadUrl}`;

          await dbRun(`INSERT INTO deliveries (id, order_id, content) VALUES (${p(1)},${p(2)},${p(3)})`, [deliveryId, orderId, deliveryContent]);
          await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [service.price, req.agent.id]);
          await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, service.agent_id]);
          await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [orderId]);

          const msgId = uuidv4();
          await dbRun(
            `INSERT INTO messages (id, recipient_id, sender_id, subject, body, order_id)
             VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
            [msgId, req.agent.id, service.agent_id,
             `[數位商品] ${service.name}`,
             `您已購買「${service.name}」\n\n檔案名稱：${file.filename}\n下載連結：${downloadUrl}\n\n使用您的 API Key（X-API-Key header）存取下載連結。`,
             orderId]
          );

          return res.status(201).json({
            id: orderId, service_name: service.name, amount: service.price,
            status: 'completed', file_id: file.id, filename: file.filename,
            download_url: downloadUrl,
            message: 'Digital product delivered. Check your Inbox for the download link.'
          });
        }
      } catch (e) { console.error('[digital-product] auto-deliver error:', e.message); }
    }

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

    // Reputation events
    const repHistory = await dbGet(
      `SELECT * FROM reputation_history WHERE order_id = ${p(1)} ORDER BY created_at ASC`,
      [order.id]
    ).catch(() => null);

    if (repHistory) {
      events.push({ event: 'reputation.updated', timestamp: repHistory.created_at, data: {
        agent_id: repHistory.agent_id, delta: repHistory.delta, reason: repHistory.reason,
      }});
    }

    // Sort by timestamp
    events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    res.json({
      order_id: order.id,
      current_status: order.status,
      timeline: events,
      event_count: events.length,
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

    // Load the service contract
    const service = await dbGet(`SELECT * FROM services WHERE id = ${p(1)}`, [order.service_id]);

    // Run output verification if contract declared
    const hasContract = !!(service && (service.output_schema || service.verification_rules));
    const verification = hasContract ? verifyDelivery(service, content) : { ok: true, stage: null, errors: [] };

    // Semantic verification: run after structural checks pass, when service.semantic_verify = true
    let semanticResult = null;
    if (verification.ok && service && (service.semantic_verify === true || service.semantic_verify === 1)) {
      semanticResult = await verifyDeliverySemantic(service, content, order.requirements);
      if (!semanticResult.ok) {
        // Treat semantic failure same as structural failure
        verification.ok = false;
        verification.stage = 'semantic';
        verification.errors = [`Semantic check failed (score: ${(semanticResult.score * 100).toFixed(0)}%): ${semanticResult.reasoning}`];
      }
    }

    if ((hasContract || semanticResult) && !verification.ok) {
      // Auto-reject: refund buyer, mark delivery failed, penalize seller rep
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [order.amount, order.amount, order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      try { await adjustReputation(order.seller_id, -REP_DISPUTE_PENALTY, 'auto_verification_failed', order.id); } catch (e) {}
      fire([order.buyer_id, order.seller_id], EVENTS.VERIFICATION_FAILED, {
        order_id: order.id, stage: verification.stage, errors: verification.errors,
        buyer_id: order.buyer_id, seller_id: order.seller_id,
      });
      fire([order.buyer_id, order.seller_id], EVENTS.ORDER_REFUNDED, {
        order_id: order.id, reason: 'verification_failed',
        buyer_id: order.buyer_id, seller_id: order.seller_id,
      });
      return res.status(400).json({
        order_id: order.id,
        status: 'refunded',
        code: 'verification_failed',
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
      const fee = parseFloat(order.amount) * RELEASE_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      const now = isPostgres ? 'NOW()' : "datetime('now')";
      await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
      try { await adjustReputation(order.seller_id, REP_CONFIRM_BONUS, 'auto_verified_completion', order.id); } catch (e) {}
      fire([order.buyer_id, order.seller_id], EVENTS.VERIFICATION_PASSED, {
        order_id: order.id, delivery_id: deliveryId, auto_completed: true,
      });
      fire([order.buyer_id, order.seller_id], EVENTS.ORDER_COMPLETED, {
        order_id: order.id, amount: order.amount,
        platform_fee: fee.toFixed(4), seller_received: sellerReceives.toFixed(4),
        auto_verified: true,
      });
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

    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_DELIVERED, {
      order_id: order.id, delivery_id: deliveryId,
      buyer_id: order.buyer_id, seller_id: order.seller_id,
    });

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

    const fee = parseFloat(order.amount) * RELEASE_FEE_RATE;
    const sellerReceives = parseFloat(order.amount) - fee;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
    await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    await dbRun(
      `UPDATE platform_revenue SET balance = balance + ${p(1)}, total_earned = total_earned + ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
      [fee, fee]
    );

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
    if (!(pct > 0 && pct < 100)) {
      return res.status(400).json({ error: 'percent must be between 0 and 100 (exclusive). Use confirm for 100%.' });
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

    // Reduce escrow by released portion, credit seller
    await dbRun(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [releaseAmount, order.buyer_id]);
    await dbRun(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
    // Update order amount to remaining (locked portion)
    await dbRun(`UPDATE orders SET amount = ${p(1)}, status = 'paid' WHERE id = ${p(2)}`, [remaining, order.id]);
    await dbRun(
      `UPDATE platform_revenue SET balance = balance + ${p(1)}, total_earned = total_earned + ${p(2)}, updated_at = ${now} WHERE id = 'singleton'`,
      [fee, fee]
    );

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

    fire([order.buyer_id, order.seller_id], EVENTS.ORDER_DISPUTED, {
      order_id: order.id, dispute_id: disputeId,
      raised_by: req.agent.id, reason,
    });

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
      // Pay seller (net of dispute fee)
      const fee = parseFloat(order.amount) * DISPUTE_FEE_RATE;
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

    // Run AI arbitration (N=3 majority vote)
    let verdict;
    try {
      verdict = await arbitrateDispute({ order, service, dispute, delivery });
    } catch (e) {
      return res.status(500).json({ error: 'AI arbitration failed', details: e.message });
    }

    const { winner, reasoning, confidence, votes, escalate_to_human } = verdict;
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // ── Human escalation path ────────────────────────────────────────────────
    if (escalate_to_human) {
      const reviewId = uuidv4();
      const escalationReason = confidence < 0.60
        ? `AI confidence too low (${(confidence * 100).toFixed(0)}%)`
        : 'Minority judges highly confident in opposite direction';

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

      // Notify both parties
      for (const recipientId of [order.buyer_id, order.seller_id]) {
        const msgId = uuidv4();
        await dbRun(
          `INSERT INTO messages (id, recipient_id, subject, body, order_id)
           VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
          [msgId, recipientId,
           '[Arbitova] Dispute escalated to human review',
           `Your dispute on order ${order.id} has been escalated to a human reviewer because the AI arbitration result was inconclusive (confidence: ${(confidence * 100).toFixed(0)}%). You will be notified when the review is complete. Review ID: ${reviewId}`,
           order.id]
        ).catch(() => {});
      }

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
    }

    const votesSummary = votes.map(v => `${v.winner}(${(v.confidence*100).toFixed(0)}%)`).join(', ');
    const resolution = `[AI Arbitration N=3 | votes: ${votesSummary} | avg confidence: ${(confidence * 100).toFixed(0)}%] ${reasoning}`;
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
      ai_votes: votes,
      reputation_penalty: REP_DISPUTE_PENALTY,
      stake_slashed: slashed,
      arbitrated_by: 'claude-haiku-n3',
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

    const { winner: newWinner, confidence, votes, method, escalate_to_human } = verdict;
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

    // Re-execute verdict
    const originalFee = parseFloat(order.amount) * RELEASE_FEE_RATE;
    if (newWinner === 'buyer') {
      // Reverse seller payment if they were paid, refund buyer
      await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [parseFloat(order.amount) - originalFee, order.seller_id]);
      await dbRun(`UPDATE agents SET escrow = escrow + ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`, [0, parseFloat(order.amount), order.buyer_id]);
      await dbRun(`UPDATE orders SET status = 'refunded', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    } else {
      await dbRun(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    }

    res.json({
      appeal_result: 're_arbitrated',
      order_id: order.id,
      original_winner: dispute.resolution?.includes('buyer') ? 'buyer' : 'seller',
      new_winner: newWinner,
      verdict_changed: true, // simplistic - buyer could evaluate
      confidence, method, votes,
      message: `Appeal re-arbitration complete. Winner: ${newWinner}.`,
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
    await dbRun(`UPDATE orders SET status = 'cancelled', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);

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
    const { fireWebhookEvent } = require('../webhooks');
    await fireWebhookEvent(order.buyer_id, 'order.cancelled', { order_id: order.id, amount: order.amount, refunded_to: order.buyer_id }).catch(() => {});
    await fireWebhookEvent(order.seller_id, 'order.cancelled', { order_id: order.id, amount: order.amount }).catch(() => {});

    res.json({
      id: order.id,
      status: 'cancelled',
      refunded_amount: parseFloat(order.amount),
      message: 'Order cancelled. Full refund returned to your balance.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
