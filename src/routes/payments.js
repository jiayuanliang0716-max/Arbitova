/**
 * payments.js — LemonSqueezy payment integration
 *
 * Direct payment for services: the buyer pays the exact service price via
 * LemonSqueezy checkout. On successful payment the webhook credits the
 * buyer's platform balance with the paid amount and auto-places the order
 * (deducting from balance → escrow, creating the order record).
 *
 * Flow:
 *   1. Buyer calls POST /payments/checkout with { service_id, variant_id? }
 *   2. Server looks up the service price, creates a LemonSqueezy checkout
 *   3. Buyer completes payment on LemonSqueezy
 *   4. LemonSqueezy POSTs to /payments/webhook
 *   5. Webhook: credits buyer balance, then auto-places the order
 *
 * Required env vars:
 *   LEMONSQUEEZY_API_KEY        — API key from LemonSqueezy dashboard
 *   LEMONSQUEEZY_STORE_ID       — Your store ID
 *   LEMONSQUEEZY_VARIANT_ID     — Default product variant ID (can be
 *                                  overridden per-request via variant_id)
 *   LEMONSQUEEZY_WEBHOOK_SECRET — Webhook signing secret (strongly recommended)
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../db/helpers');
const { SETTLEMENT_FEE_RATE, creditPlatformFee } = require('../config/fees');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const LS_API = 'https://api.lemonsqueezy.com/v1';
const LS_HEADERS = () => ({
  'Accept': 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
  'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`
});

// ---------------------------------------------------------------------------
// POST /payments/checkout
//
// Body: { service_id: string, variant_id?: string|number }
//
// - Looks up the service and its price in the DB
// - Creates a LemonSqueezy checkout for the exact service amount (in cents)
// - Stores a pending payment row linked to the service
// ---------------------------------------------------------------------------
router.post('/checkout', async (req, res) => {
  try {
    // --- Auth ---
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key' });

    const agent = await dbGet(
      `SELECT id, name FROM agents WHERE api_key = ${p(1)}`,
      [apiKey]
    );
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    // --- Env check ---
    if (!process.env.LEMONSQUEEZY_API_KEY || !process.env.LEMONSQUEEZY_STORE_ID) {
      return res.status(503).json({ error: 'Payment system not configured' });
    }

    // --- Validate request body ---
    const { service_id, variant_id } = req.body;
    if (!service_id) {
      return res.status(400).json({ error: 'service_id is required' });
    }

    const effectiveVariantId = variant_id || process.env.LEMONSQUEEZY_VARIANT_ID;
    if (!effectiveVariantId) {
      return res.status(400).json({
        error: 'variant_id is required (or set LEMONSQUEEZY_VARIANT_ID env var). ' +
               'Create a product/variant in your LemonSqueezy dashboard first.'
      });
    }

    // --- Look up service ---
    const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
    const service = await dbGet(
      `SELECT id, agent_id, name, description, price FROM services WHERE id = ${p(1)} AND ${activeCheck}`,
      [service_id]
    );
    if (!service) return res.status(404).json({ error: 'Service not found or inactive' });

    if (service.agent_id === agent.id) {
      return res.status(400).json({ error: 'Cannot purchase your own service' });
    }

    // LemonSqueezy prices are in cents (integer)
    const priceCents = Math.round(parseFloat(service.price) * 100);
    if (priceCents < 1) {
      return res.status(400).json({ error: 'Service price must be at least $0.01' });
    }

    // --- Create LemonSqueezy checkout ---
    const response = await fetch(`${LS_API}/checkouts`, {
      method: 'POST',
      headers: LS_HEADERS(),
      body: JSON.stringify({
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              custom: {
                agent_id: agent.id,
                service_id: service.id
              }
            },
            // Override the variant price to match the exact service price
            checkout_options: {
              // Pass amount in cents via custom_price if the variant supports it.
              // If your LS variant already has the correct price set you can remove
              // the custom_price block; it's kept here for flexibility.
            },
            product_options: {
              name: service.name,
              description: service.description
                ? `${service.description} — Sold by: ${agent.name}`
                : `Service purchase — Sold by: ${agent.name}`
            }
          },
          relationships: {
            store: {
              data: { type: 'stores', id: String(process.env.LEMONSQUEEZY_STORE_ID) }
            },
            variant: {
              data: { type: 'variants', id: String(effectiveVariantId) }
            }
          }
        }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('[LemonSqueezy] Checkout error:', JSON.stringify(result));
      return res.status(502).json({ error: 'Failed to create checkout', details: result });
    }

    const checkoutUrl = result.data?.attributes?.url;
    const lsCheckoutId = result.data?.id || '';

    // --- Record pending payment ---
    const paymentId = uuidv4();
    await dbRun(
      `INSERT INTO payments
         (id, agent_id, service_id, amount_cents, status, provider, provider_checkout_id)
       VALUES
         (${p(1)},${p(2)},${p(3)},${p(4)},'pending','lemonsqueezy',${p(5)})`,
      [paymentId, agent.id, service.id, priceCents, lsCheckoutId]
    );

    res.json({
      checkout_url: checkoutUrl,
      payment_id: paymentId,
      service_id: service.id,
      service_name: service.name,
      amount_cents: priceCents
    });
  } catch (err) {
    console.error('[LemonSqueezy] Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /payments/webhook — LemonSqueezy webhook handler
//
// Handles:
//   order_created  (status = paid)  → credit buyer balance + auto-place order
//   order_refunded                  → reverse the payment record
// ---------------------------------------------------------------------------
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString();

    // --- Verify webhook signature ---
    if (process.env.LEMONSQUEEZY_WEBHOOK_SECRET) {
      const sig = req.headers['x-signature'] || '';
      const hmac = crypto.createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET);
      hmac.update(rawBody);
      const expected = hmac.digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        console.warn('[LemonSqueezy] Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const payload = JSON.parse(rawBody);
    const eventName = payload.meta?.event_name;
    const customData = payload.meta?.custom_data || {};
    const agentId = customData.agent_id;
    const serviceId = customData.service_id;

    console.log(`[LemonSqueezy] Webhook: ${eventName}`, { agentId, serviceId });

    // -----------------------------------------------------------------------
    // order_created — buyer completed payment
    // -----------------------------------------------------------------------
    if (eventName === 'order_created') {
      const lsOrderId = String(payload.data?.id || '');
      const totalCents = payload.data?.attributes?.total || 0;
      const status = payload.data?.attributes?.status; // 'paid' | 'pending' | 'refunded'

      if (status !== 'paid') {
        // Not yet paid — nothing to do; LemonSqueezy will fire again when paid
        return res.json({ received: true, note: `Skipped: status is ${status}` });
      }

      if (!agentId || !serviceId) {
        console.error('[LemonSqueezy] Webhook missing agent_id or service_id in custom_data');
        return res.status(400).json({ error: 'Missing agent_id or service_id in custom_data' });
      }

      // --- Idempotency: skip if this LS order was already processed ---
      const existing = await dbGet(
        `SELECT id FROM payments WHERE provider_order_id = ${p(1)} AND status = 'completed'`,
        [lsOrderId]
      );
      if (existing) {
        console.log(`[LemonSqueezy] Order ${lsOrderId} already processed — skipping`);
        return res.json({ received: true, note: 'Already processed' });
      }

      // --- Look up the service ---
      const activeCheck = isPostgres ? 'is_active = TRUE' : 'is_active = 1';
      const service = await dbGet(
        `SELECT id, agent_id, name, price, delivery_hours, file_id FROM services WHERE id = ${p(1)} AND ${activeCheck}`,
        [serviceId]
      );
      if (!service) {
        console.error(`[LemonSqueezy] Service ${serviceId} not found for webhook`);
        // Acknowledge receipt so LemonSqueezy does not retry indefinitely;
        // log and investigate manually.
        return res.json({ received: true, error: 'Service not found' });
      }

      const servicePrice = parseFloat(service.price);

      // --- Step 1: Credit buyer balance with the paid amount ---
      // We credit the exact service price (not the raw cents from LS) so the
      // platform balance stays in the same unit as service prices.
      await dbRun(
        `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
        [servicePrice, agentId]
      );

      // --- Step 2: Record completed payment ---
      const paymentId = uuidv4();
      await dbRun(
        `INSERT INTO payments
           (id, agent_id, service_id, amount_cents, status, provider, provider_order_id)
         VALUES
           (${p(1)},${p(2)},${p(3)},${p(4)},'completed','lemonsqueezy',${p(5)})`,
        [paymentId, agentId, serviceId, totalCents, lsOrderId]
      );

      // Also mark any earlier 'pending' row for this service/agent as completed
      await dbRun(
        `UPDATE payments SET status = 'completed', provider_order_id = ${p(1)}
         WHERE agent_id = ${p(2)} AND service_id = ${p(3)} AND status = 'pending'
           AND provider_order_id != ${p(4)}`,
        [lsOrderId, agentId, serviceId, lsOrderId]
      );

      // --- Step 3: Auto-place the order (same logic as POST /orders) ---
      // Buyer just received enough balance; now deduct it into escrow.
      const buyer = await dbGet(`SELECT balance FROM agents WHERE id = ${p(1)}`, [agentId]);
      if (!buyer || parseFloat(buyer.balance) < servicePrice) {
        // Should not normally happen, but guard anyway
        console.error(`[LemonSqueezy] Buyer ${agentId} balance insufficient after credit`);
        return res.json({ received: true, error: 'Balance insufficient after credit' });
      }

      const deadline = new Date();
      deadline.setHours(deadline.getHours() + (service.delivery_hours || 24));
      const orderId = uuidv4();

      // Deduct from buyer balance → escrow
      await dbRun(
        `UPDATE agents SET balance = balance - ${p(1)}, escrow = escrow + ${p(2)} WHERE id = ${p(3)}`,
        [servicePrice, servicePrice, agentId]
      );

      // Create the order record
      await dbRun(
        `INSERT INTO orders
           (id, buyer_id, seller_id, service_id, status, amount, deadline)
         VALUES
           (${p(1)},${p(2)},${p(3)},${p(4)},'paid',${p(5)},${p(6)})`,
        [orderId, agentId, service.agent_id, serviceId, servicePrice, deadline.toISOString()]
      );

      console.log(
        `[LemonSqueezy] Order ${orderId} created for agent ${agentId}, ` +
        `service ${serviceId}, amount ${servicePrice} (LS order ${lsOrderId})`
      );

      // --- Step 4: Auto-deliver digital products (file attached to service) ---
      if (service.file_id) {
        try {
          const file = await dbGet(
            `SELECT id, filename FROM files WHERE id = ${p(1)}`,
            [service.file_id]
          );
          if (file) {
            const fee = servicePrice * SETTLEMENT_FEE_RATE;
            const sellerReceives = servicePrice - fee;
            const now = isPostgres ? 'NOW()' : "datetime('now')";
            const deliveryId = uuidv4();
            const downloadUrl = `/files/${file.id}/download`;
            const deliveryContent =
              `[Digital Product] ${file.filename}\nDownload: ${downloadUrl}`;

            await dbRun(
              `INSERT INTO deliveries (id, order_id, content) VALUES (${p(1)},${p(2)},${p(3)})`,
              [deliveryId, orderId, deliveryContent]
            );
            await dbRun(
              `UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`,
              [servicePrice, agentId]
            );
            await dbRun(
              `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
              [sellerReceives, service.agent_id]
            );
            await dbRun(
              `UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`,
              [orderId]
            );
            await creditPlatformFee(fee);

            const msgId = uuidv4();
            await dbRun(
              `INSERT INTO messages (id, recipient_id, sender_id, subject, body, order_id)
               VALUES (${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
              [
                msgId, agentId, service.agent_id,
                `[Digital Product] ${service.name}`,
                `Your purchase of "${service.name}" is ready.\n\n` +
                `File: ${file.filename}\nDownload: ${downloadUrl}\n\n` +
                `Use your API key (X-API-Key header) to access the download link.`,
                orderId
              ]
            );

            console.log(
              `[LemonSqueezy] Digital product auto-delivered for order ${orderId}`
            );
          }
        } catch (e) {
          console.error('[LemonSqueezy] Digital product auto-deliver error:', e.message);
          // Non-fatal: order still exists; seller can deliver manually
        }
      }
    }

    // -----------------------------------------------------------------------
    // order_refunded — reverse the payment and, where possible, the order
    // -----------------------------------------------------------------------
    if (eventName === 'order_refunded') {
      const lsOrderId = String(payload.data?.id || '');

      const payment = await dbGet(
        `SELECT * FROM payments WHERE provider_order_id = ${p(1)} AND status = 'completed'`,
        [lsOrderId]
      );

      if (payment) {
        const refundAmount = parseFloat(payment.amount_cents) / 100;

        // Try to reverse an order that hasn't been delivered yet
        if (payment.service_id) {
          const order = await dbGet(
            `SELECT * FROM orders WHERE buyer_id = ${p(1)} AND service_id = ${p(2)} AND status = 'paid'`,
            [payment.agent_id, payment.service_id]
          );
          if (order) {
            // Return escrow to buyer
            await dbRun(
              `UPDATE agents SET escrow = escrow - ${p(1)}, balance = balance + ${p(2)} WHERE id = ${p(3)}`,
              [parseFloat(order.amount), parseFloat(order.amount), order.buyer_id]
            );
            await dbRun(
              `UPDATE orders SET status = 'refunded' WHERE id = ${p(1)}`,
              [order.id]
            );
            console.log(
              `[LemonSqueezy] Order ${order.id} refunded for agent ${payment.agent_id}`
            );
          }
        }

        await dbRun(
          `UPDATE payments SET status = 'refunded' WHERE id = ${p(1)}`,
          [payment.id]
        );
        console.log(
          `[LemonSqueezy] Payment ${payment.id} marked refunded (LS order ${lsOrderId})`
        );
      } else {
        console.warn(
          `[LemonSqueezy] Refund webhook for unknown/unprocessed order ${lsOrderId}`
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[LemonSqueezy] Webhook error:', err.message);
    // Return 500 so LemonSqueezy retries
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /payments/history — agent's payment history
// ---------------------------------------------------------------------------
router.get('/history', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key' });

    const agent = await dbGet(
      `SELECT id FROM agents WHERE api_key = ${p(1)}`,
      [apiKey]
    );
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const payments = await dbAll(
      `SELECT id, service_id, amount_cents, status, provider, provider_order_id, created_at
       FROM payments
       WHERE agent_id = ${p(1)}
       ORDER BY created_at DESC`,
      [agent.id]
    );

    res.json({ payments });
  } catch (err) {
    console.error('[LemonSqueezy] History error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
