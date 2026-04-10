/**
 * payments.js — LemonSqueezy payment integration
 *
 * Allows agents to purchase platform credits with fiat currency.
 *
 * Flow:
 *   1. Agent calls POST /payments/checkout → gets LemonSqueezy checkout URL
 *   2. User completes payment on LemonSqueezy
 *   3. LemonSqueezy sends webhook to POST /payments/webhook
 *   4. Webhook handler credits agent balance
 *
 * Required env vars:
 *   LEMONSQUEEZY_API_KEY     — API key from LemonSqueezy dashboard
 *   LEMONSQUEEZY_STORE_ID    — Your store ID
 *   LEMONSQUEEZY_WEBHOOK_SECRET — Webhook signing secret (optional but recommended)
 */

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun, dbAll } = require('../db/helpers');

const router = express.Router();

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';

const LS_API = 'https://api.lemonsqueezy.com/v1';
const LS_HEADERS = () => ({
  'Accept': 'application/vnd.api+json',
  'Content-Type': 'application/vnd.api+json',
  'Authorization': `Bearer ${process.env.LEMONSQUEEZY_API_KEY}`
});

// Credit packages: amount in platform credits → price in USD cents
const CREDIT_PACKAGES = [
  { id: 'credits_10',   credits: 10,   price_cents: 500,   label: '$5 → 10 credits' },
  { id: 'credits_50',   credits: 50,   price_cents: 2000,  label: '$20 → 50 credits' },
  { id: 'credits_100',  credits: 100,  price_cents: 3500,  label: '$35 → 100 credits' },
  { id: 'credits_500',  credits: 500,  price_cents: 15000, label: '$150 → 500 credits' },
];

// GET /payments/packages — list available credit packages
router.get('/packages', (req, res) => {
  res.json({ packages: CREDIT_PACKAGES });
});

// POST /payments/checkout — create a LemonSqueezy checkout session
router.post('/checkout', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key' });

    const agent = await dbGet(
      isPostgres ? 'SELECT id, name FROM agents WHERE api_key = $1' : 'SELECT id, name FROM agents WHERE api_key = ?',
      [apiKey]
    );
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    if (!process.env.LEMONSQUEEZY_API_KEY || !process.env.LEMONSQUEEZY_STORE_ID) {
      return res.status(503).json({ error: 'Payment system not configured' });
    }

    const { variant_id, package_id } = req.body;

    // If using predefined packages (variant_id comes from LemonSqueezy product setup)
    if (!variant_id) {
      return res.status(400).json({
        error: 'variant_id is required. Set up products in LemonSqueezy dashboard first.',
        packages: CREDIT_PACKAGES
      });
    }

    const pkg = package_id ? CREDIT_PACKAGES.find(p => p.id === package_id) : null;

    // Create checkout via LemonSqueezy API
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
                package_id: package_id || 'custom'
              }
            },
            product_options: {
              name: pkg ? pkg.label : 'A2A Platform Credits',
              description: `Credits for agent: ${agent.name}`
            }
          },
          relationships: {
            store: {
              data: { type: 'stores', id: process.env.LEMONSQUEEZY_STORE_ID }
            },
            variant: {
              data: { type: 'variants', id: String(variant_id) }
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

    // Record pending payment
    const paymentId = uuidv4();
    await dbRun(
      `INSERT INTO payments (id, agent_id, amount_cents, credits, status, provider, provider_checkout_id)
       VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'pending','lemonsqueezy',${p(5)})`,
      [paymentId, agent.id, pkg?.price_cents || 0, pkg?.credits || 0, result.data?.id || '']
    );

    res.json({
      checkout_url: checkoutUrl,
      payment_id: paymentId
    });
  } catch (err) {
    console.error('[LemonSqueezy] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /payments/webhook — LemonSqueezy webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString();

    // Verify webhook signature if secret is configured
    if (process.env.LEMONSQUEEZY_WEBHOOK_SECRET) {
      const sig = req.headers['x-signature'] || '';
      const hmac = crypto.createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET);
      hmac.update(rawBody);
      const expected = hmac.digest('hex');
      if (sig !== expected) {
        console.warn('[LemonSqueezy] Invalid webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const payload = JSON.parse(rawBody);
    const eventName = payload.meta?.event_name;
    const customData = payload.meta?.custom_data || {};
    const agentId = customData.agent_id;
    const packageId = customData.package_id;

    console.log(`[LemonSqueezy] Webhook: ${eventName}`, { agentId, packageId });

    if (eventName === 'order_created') {
      const orderId = payload.data?.id;
      const totalCents = payload.data?.attributes?.total || 0;
      const status = payload.data?.attributes?.status; // 'paid', 'pending', 'refunded'

      if (status === 'paid' && agentId) {
        // Find matching package or calculate credits from amount
        const pkg = CREDIT_PACKAGES.find(p => p.id === packageId);
        const credits = pkg ? pkg.credits : Math.floor(totalCents / 50); // fallback: 50 cents per credit

        // Credit agent balance
        await dbRun(
          `UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`,
          [credits, agentId]
        );

        // Record payment
        const paymentId = uuidv4();
        await dbRun(
          `INSERT INTO payments (id, agent_id, amount_cents, credits, status, provider, provider_order_id)
           VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'completed','lemonsqueezy',${p(5)})
           ON CONFLICT DO NOTHING`,
          [paymentId, agentId, totalCents, credits, String(orderId)]
        );

        console.log(`[LemonSqueezy] Credited ${credits} to agent ${agentId} (order ${orderId})`);
      }
    }

    if (eventName === 'order_refunded') {
      const orderId = String(payload.data?.id);
      // Find and reverse the payment
      const payment = await dbGet(
        `SELECT * FROM payments WHERE provider_order_id = ${p(1)} AND status = 'completed'`,
        [orderId]
      );
      if (payment) {
        await dbRun(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [payment.credits, payment.agent_id]);
        await dbRun(`UPDATE payments SET status = 'refunded' WHERE id = ${p(1)}`, [payment.id]);
        console.log(`[LemonSqueezy] Refunded ${payment.credits} from agent ${payment.agent_id}`);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[LemonSqueezy] Webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /payments/history — agent's payment history
router.get('/history', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key' });

    const agent = await dbGet(
      isPostgres ? 'SELECT id FROM agents WHERE api_key = $1' : 'SELECT id FROM agents WHERE api_key = ?',
      [apiKey]
    );
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const payments = await dbAll(
      `SELECT id, amount_cents, credits, status, provider, created_at FROM payments WHERE agent_id = ${p(1)} ORDER BY created_at DESC`,
      [agent.id]
    );

    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
