const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi.json');
const cors = require('cors');
const cron = require('node-cron');

// 初始化資料庫（必須在 routes 之前）
require('./db/schema');

const agentRoutes = require('./routes/agents');
const serviceRoutes = require('./routes/services');
const orderRoutes = require('./routes/orders');
const telegramRoutes = require('./routes/telegram');
const subscriptionRoutes = require('./routes/subscriptions');
const withdrawalRoutes = require('./routes/withdrawals');
const webhookRouter = require('./webhook');
const messageRoutes = require('./routes/messages');
const fileRoutes = require('./routes/files');
const paymentRoutes = require('./routes/payments');
const reviewRoutes = require('./routes/reviews');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const apiKeyRoutes = require('./routes/apikeys');
const { dbAll, dbRun } = require('./db/helpers');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// CORS — allow same-origin and the Render deployment URL
const allowedOrigins = [
  'https://a2a-system.onrender.com',
  'http://localhost:3000',
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : [])
];
app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Admin-Key'],
}));

// Rate limiting：每個 IP 每分鐘最多 60 次請求（測試模式提高上限）
const rateMax = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT ? 10000 : 60;
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: rateMax,
  message: { error: 'Too many requests, please slow down.' }
}));

// Static frontend (SPA — public/index.html is served at /)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Stats endpoint — 30s in-memory cache to reduce DB load
let statsCache = null;
let statsCacheAt = 0;
app.get('/api/stats', async (req, res) => {
  try {
    if (statsCache && Date.now() - statsCacheAt < 30000) return res.json(statsCache);
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const [agents, services, orders] = await Promise.all([
      dbAll('SELECT COUNT(*) as count FROM agents', []),
      dbAll('SELECT COUNT(*) as count FROM services', []),
      dbAll(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as fees FROM orders WHERE status = ${p(1)}`, ['completed'])
    ]);
    statsCache = {
      agents: parseInt(agents[0].count),
      services: parseInt(services[0].count),
      completed_orders: parseInt(orders[0].count),
      platform_fees: parseFloat(orders[0].fees || 0)
    };
    statsCacheAt = Date.now();
    res.json(statsCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Internal AI generation endpoint — requires valid agent API key
app.post('/api/generate', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing X-API-Key' });
    const { dbGet } = require('./db/helpers');
    const isPostgres = !!process.env.DATABASE_URL;
    const agent = await dbGet(
      isPostgres ? 'SELECT id FROM agents WHERE api_key = $1' : 'SELECT id FROM agents WHERE api_key = ?',
      [apiKey]
    );
    if (!agent) return res.status(401).json({ error: 'Invalid API key' });

    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured on server' });

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ result: msg.content[0].text });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mode check (no sensitive data exposed)
app.get('/api/mode', (req, res) => {
  res.json({
    chain_mode: !!(process.env.ALCHEMY_API_KEY && process.env.WALLET_ENCRYPTION_KEY),
    has_alchemy: !!process.env.ALCHEMY_API_KEY,
    has_enc_key: !!process.env.WALLET_ENCRYPTION_KEY,
    chain: process.env.CHAIN || 'base-sepolia',
    has_lemonsqueezy: !!process.env.LEMONSQUEEZY_API_KEY
  });
});

// API Docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Routes — v1 (canonical, SDK points here)
const apiV1 = express.Router();
apiV1.use('/agents', agentRoutes);
apiV1.use('/services', serviceRoutes);
apiV1.use('/orders', orderRoutes);
apiV1.use('/subscriptions', subscriptionRoutes);
apiV1.use('/withdrawals', withdrawalRoutes);
apiV1.use('/messages', messageRoutes);
apiV1.use('/files', fileRoutes);
apiV1.use('/payments', paymentRoutes);
apiV1.use('/reviews', reviewRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/webhooks', webhookRoutes);
apiV1.use('/api-keys', apiKeyRoutes);

// GET /api/v1/ — API overview
apiV1.get('/', (req, res) => {
  res.json({
    name: 'Arbitova API',
    version: 'v1',
    description: 'Trust infrastructure for AI agent transactions — escrow, verification, arbitration.',
    base_url: '/api/v1',
    docs: '/docs',
    endpoints: {
      identity:      ['POST /agents/register', 'GET /agents/:id', 'GET /agents/:id/reputation'],
      contracts:     ['POST /services', 'GET /services/:id', 'PUT /services/:id'],
      transactions:  ['POST /orders', 'POST /orders/:id/deliver', 'POST /orders/:id/confirm', 'POST /orders/:id/dispute', 'POST /orders/:id/auto-arbitrate'],
      funding:       ['POST /payments/checkout', 'POST /agents/:id/sync-balance'],
      webhooks:      ['POST /webhooks', 'GET /webhooks', 'DELETE /webhooks/:id'],
      api_keys:      ['POST /api-keys', 'GET /api-keys', 'DELETE /api-keys/:id'],
    },
    events: [
      'order.created', 'order.delivered', 'order.completed',
      'order.refunded', 'order.disputed', 'dispute.resolved',
      'verification.passed', 'verification.failed',
    ],
  });
});
app.use('/api/v1', apiV1);

// Legacy routes — kept for backward compatibility with existing frontend
app.use('/agents', agentRoutes);
app.use('/services', serviceRoutes);
app.use('/orders', orderRoutes);
app.use('/telegram', telegramRoutes);
app.use('/subscriptions', subscriptionRoutes);
app.use('/withdrawals', withdrawalRoutes);
app.use('/webhook', webhookRouter);
app.use('/messages', messageRoutes);
app.use('/files', fileRoutes);
app.use('/payments', paymentRoutes);
app.use('/reviews', reviewRoutes);
app.use('/admin', adminRoutes);

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: 'v1', timestamp: new Date().toISOString() });
});
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', version: 'v1', timestamp: new Date().toISOString() });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'not_found',
    docs: '/docs',
  });
});

// 全域錯誤處理 — 標準化錯誤格式
app.use((err, req, res, next) => {
  console.error(err.stack);

  // Validation errors (e.g. missing required fields)
  if (err.status === 400 || err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: err.message, code: 'bad_request' });
  }

  res.status(500).json({
    error: 'Internal server error',
    code: 'internal_error',
  });
});

// ── Cron: process subscription billing every hour ──────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const PLATFORM_FEE_RATE = 0.025;
    const now = new Date().toISOString();
    const due = await dbAll(
      `SELECT sub.*, s.name as service_name
       FROM subscriptions sub JOIN services s ON sub.service_id = s.id
       WHERE sub.status = 'active' AND sub.next_billing_at <= ${p(1)}`,
      [now]
    );
    let billed = 0, cancelled = 0;
    for (const sub of due) {
      const price = parseFloat(sub.price);
      const buyer = await dbAll(`SELECT balance FROM agents WHERE id = ${p(1)}`, [sub.buyer_id]);
      const balance = parseFloat(buyer[0]?.balance || 0);
      const cancelNow = isPostgres ? 'NOW()' : "datetime('now')";
      if (balance < price) {
        await dbAll(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = ${cancelNow} WHERE id = ${p(1)}`, [sub.id]);
        cancelled++;
        continue;
      }
      const sellerReceives = price * (1 - PLATFORM_FEE_RATE);
      const nextBilling = (() => {
        const d = new Date();
        if (sub.interval === 'daily')   d.setDate(d.getDate() + 1);
        if (sub.interval === 'weekly')  d.setDate(d.getDate() + 7);
        if (sub.interval === 'monthly') d.setMonth(d.getMonth() + 1);
        return d.toISOString();
      })();
      await dbAll(`UPDATE agents SET balance = balance - ${p(1)} WHERE id = ${p(2)}`, [price, sub.buyer_id]);
      await dbAll(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, sub.seller_id]);
      await dbAll(`UPDATE subscriptions SET next_billing_at = ${p(1)} WHERE id = ${p(2)}`, [nextBilling, sub.id]);

      // Create a content-delivery order so seller-agent can generate and deliver
      const contentOrderId = uuidv4();
      const deadline = new Date();
      deadline.setHours(deadline.getHours() + 2);
      await dbAll(
        `INSERT INTO orders (id, buyer_id, seller_id, service_id, status, amount, requirements, subscription_id, deadline)
         VALUES (${p(1)},${p(2)},${p(3)},${p(4)},'paid',0,${p(5)},${p(6)},${p(7)})`,
        [contentOrderId, sub.buyer_id, sub.seller_id, sub.service_id, sub.service_name, sub.id, deadline.toISOString()]
      );

      billed++;
    }
    if (due.length > 0) console.log(`[cron] subscription billing: ${billed} billed, ${cancelled} cancelled`);
  } catch (err) {
    console.error('[cron] subscription billing error:', err.message);
  }
});

// ── Cron: expire overdue orders every 10 minutes ────────────────────────────
cron.schedule('*/10 * * * *', async () => {
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const now = new Date().toISOString();
    const expired = await dbAll(
      `SELECT * FROM orders WHERE status = 'paid' AND deadline < ${p(1)}`,
      [now]
    );
    for (const order of expired) {
      // Refund buyer: move escrow back to balance
      await dbAll(
        `UPDATE agents SET balance = balance + ${p(1)}, escrow = escrow - ${p(2)} WHERE id = ${p(3)}`,
        [order.amount, order.amount, order.buyer_id]
      );
      const expiredNow = isPostgres ? 'NOW()' : "datetime('now')";
      await dbAll(
        `UPDATE orders SET status = 'refunded', completed_at = ${expiredNow} WHERE id = ${p(1)}`,
        [order.id]
      );
    }
    if (expired.length > 0) console.log(`[cron] expired orders refunded: ${expired.length}`);
  } catch (err) {
    console.error('[cron] order expiry error:', err.message);
  }
});

// ── Cron: auto-confirm delivered orders after 48h (P2) ──────────────────────
// If buyer never disputes or confirms within 48h of delivery, auto-confirm for seller.
cron.schedule('*/30 * * * *', async () => {
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const PLATFORM_FEE_RATE = 0.025;
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const now = isPostgres ? 'NOW()' : "datetime('now')";

    // Orders in 'delivered' status with delivery older than 48h
    const stale = await dbAll(
      `SELECT o.* FROM orders o
       JOIN deliveries d ON d.order_id = o.id
       WHERE o.status = 'delivered' AND d.delivered_at < ${p(1)}`,
      [cutoff]
    );

    for (const order of stale) {
      const fee = parseFloat(order.amount) * PLATFORM_FEE_RATE;
      const sellerReceives = parseFloat(order.amount) - fee;
      await dbAll(`UPDATE agents SET escrow = escrow - ${p(1)} WHERE id = ${p(2)}`, [order.amount, order.buyer_id]);
      await dbAll(`UPDATE agents SET balance = balance + ${p(1)} WHERE id = ${p(2)}`, [sellerReceives, order.seller_id]);
      await dbAll(`UPDATE orders SET status = 'completed', completed_at = ${now} WHERE id = ${p(1)}`, [order.id]);
    }
    if (stale.length > 0) console.log(`[cron] auto-confirmed ${stale.length} stale delivered orders`);
  } catch (err) {
    console.error('[cron] auto-confirm error:', err.message);
  }
});

// ── Cron: daily reconciliation at 02:00 UTC (P1) ────────────────────────────
// Verifies that SUM(agents.escrow) == SUM(orders.amount WHERE status='paid' OR 'delivered').
// Logs discrepancies — flag for manual investigation.
cron.schedule('0 2 * * *', async () => {
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';

    const [escrowSum, ordersSum] = await Promise.all([
      dbAll('SELECT COALESCE(SUM(escrow), 0) as total FROM agents', []),
      dbAll(`SELECT COALESCE(SUM(amount), 0) as total FROM orders WHERE status IN ('paid', 'delivered', 'disputed', 'under_review')`, []),
    ]);

    const escrowTotal  = parseFloat(escrowSum[0]?.total  || 0);
    const ordersTotal  = parseFloat(ordersSum[0]?.total  || 0);
    const delta        = Math.abs(escrowTotal - ordersTotal);
    const threshold    = 0.01; // allow $0.01 floating point tolerance

    if (delta > threshold) {
      console.error(`[reconciliation] MISMATCH: escrow_sum=${escrowTotal} orders_sum=${ordersTotal} delta=${delta.toFixed(6)}`);
      // TODO: fire an alert webhook / Slack notification when wired up
    } else {
      console.log(`[reconciliation] OK: escrow=${escrowTotal} orders_in_flight=${ordersTotal}`);
    }

    // Purge expired idempotency keys
    const expiredNow = isPostgres ? 'NOW()' : "datetime('now')";
    await dbAll(`DELETE FROM idempotency_keys WHERE expires_at < ${expiredNow}`, [])
      .catch(() => {});
  } catch (err) {
    console.error('[cron] reconciliation error:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Arbitova running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
