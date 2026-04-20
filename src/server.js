const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi.json');
const cors = require('cors');
const nodemailer = require('nodemailer');

// 初始化資料庫（必須在 routes 之前）
require('./db/schema');

const { SETTLEMENT_FEE_RATE, DISPUTE_FEE_RATE, EXTERNAL_ARB_RATE } = require('./config/fees');

const agentRoutes = require('./routes/agents');
const serviceRoutes = require('./routes/services');
const orderRoutes = require('./routes/orders');
const withdrawalRoutes = require('./routes/withdrawals');
const webhookRouter = require('./webhook');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const apiKeyRoutes = require('./routes/apikeys');
const { router: x402Routes, PLATFORM_ADDRESS } = require('./routes/x402route');
const arbitrationRoutes = require('./routes/arbitration');
const credentialRoutes = require('./routes/credentials');
const mcpHttpRoutes = require('./routes/mcp-http');
const postRoutes = require('./routes/posts');
const authRoutes = require('./routes/auth');
const { dbAll } = require('./db/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Auto-inject error `code` field — standardizes all error responses
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = (body) => {
    if (body && body.error && !body.code) {
      const status = res.statusCode || 200;
      if (status === 400) body.code = 'bad_request';
      else if (status === 401) body.code = 'unauthorized';
      else if (status === 403) body.code = 'forbidden';
      else if (status === 404) body.code = 'not_found';
      else if (status === 409) body.code = 'conflict';
      else if (status === 429) body.code = 'rate_limited';
      else if (status >= 500) body.code = 'internal_error';
    }
    return _json(body);
  };
  next();
});

// CORS
const allowedOrigins = [
  'https://arbitova.com',
  'https://www.arbitova.com',
  'https://api.arbitova.com',
  'http://localhost:3000',
  ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : [])
];
app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Admin-Key', 'X-Idempotency-Key'],
  exposedHeaders: ['X-Request-ID', 'X-RateLimit-Remaining'],
}));

// Rate limiting：每個 IP 每分鐘最多 60 次請求（測試模式提高上限）
const rateMax = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT ? 10000 : 60;
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: rateMax,
  standardHeaders: true,   // Returns RateLimit-* headers
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.', code: 'rate_limited' }
}));

// X-Request-ID and X-Arbitova-Version — attach to every response
const { v4: reqUuid } = require('uuid');
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || reqUuid();
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Arbitova-Version', '1.2.0');
  req.requestId = requestId;
  next();
});

// Canonical domain redirect — send old Render URL to arbitova.com
app.use((req, res, next) => {
  if (req.hostname === 'a2a-system.onrender.com') {
    return res.redirect(301, 'https://arbitova.com' + req.path + (req.search ? '?' + req.search : ''));
  }
  next();
});

// Static frontend (SPA — public/index.html is served at /)
// Cache static assets aggressively so Cloudflare doesn't hit Render every time
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '7d',
  setHeaders(res, filePath) {
    // favicon and icons: cache 30 days
    if (filePath.endsWith('.ico') || filePath.endsWith('.png') || filePath.endsWith('.svg')) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
    // HTML: no cache (so updates are seen immediately)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Clean URL aliases for standalone pages
app.get('/profile',  (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'profile.html')));
app.get('/badge',    (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'badge.html')));
app.get('/verdicts', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'verdicts.html')));
app.get('/status',   (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'status.html')));
app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// Stats endpoint — 30s in-memory cache to reduce DB load
let statsCache = null;
let statsCacheAt = 0;
app.get('/api/stats', async (req, res) => {
  try {
    if (statsCache && Date.now() - statsCacheAt < 30000) return res.json(statsCache);
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const [agents, services, completed, disputed, total_vol] = await Promise.all([
      dbAll('SELECT COUNT(*) as count FROM agents', []),
      dbAll(`SELECT COUNT(*) as count FROM services WHERE is_active = ${isPostgres ? 'TRUE' : '1'}`, []),
      dbAll(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as vol FROM orders WHERE status = ${p(1)}`, ['completed']),
      dbAll(`SELECT COUNT(*) as count FROM orders WHERE status = ${p(1)}`, ['disputed']),
      dbAll(`SELECT COALESCE(SUM(amount), 0) as vol FROM orders WHERE status NOT IN (${p(1)},${p(2)})`, ['cancelled', 'refunded']),
    ]);
    statsCache = {
      agents: parseInt(agents[0].count),
      services: parseInt(services[0].count),
      completed_orders: parseInt(completed[0].count),
      active_disputes: parseInt(disputed[0].count),
      total_volume: parseFloat(total_vol[0].vol || 0),
      platform_fees: parseFloat(completed[0].vol || 0) * SETTLEMENT_FEE_RATE,
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
    chain: process.env.CHAIN || 'base-sepolia'
  });
});

// API Reference (Swagger UI)
app.use('/api-reference', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Quick Start Docs
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs.html')));

// System Architecture
app.get('/architecture', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'architecture.html')));

// Pricing
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'pricing.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'blog.html')));
app.get('/feedback', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'feedback.html')));

// ── Contact Form ─────────────────────────────────────────────────────────────
const contactLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { error: 'Too many messages. Try again in an hour.' } });

const CATEGORY_TAGS = { bug: 'Bug', feature: 'Feature', question: 'Question', other: 'Other', contact: 'Contact' };

app.post('/contact', contactLimiter, async (req, res) => {
  try {
    const { name, email, subject, message, category } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'name, email, and message are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: 'Message too long (max 5000 characters)' });
    }

    if (!process.env.BREVO_SMTP_KEY || !process.env.BREVO_SMTP_NAME) {
      console.error('Contact form: BREVO_SMTP_KEY or BREVO_SMTP_NAME not set');
      return res.status(503).json({ error: 'Email service not configured' });
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.BREVO_SMTP_NAME,
        pass: process.env.BREVO_SMTP_KEY,
      },
    });

    const tag = CATEGORY_TAGS[String(category || 'contact').toLowerCase()] || 'Contact';
    await transporter.sendMail({
      from: `"Arbitova Contact" <dev@arbitova.com>`,
      to: 'dev@arbitova.com',
      replyTo: `"${name}" <${email}>`,
      subject: `[${tag}] ${subject || 'New message from ' + name}`,
      text: `Category: ${tag}\nName: ${name}\nEmail: ${email}\n\n${message}`,
      html: `<p><strong>Category:</strong> ${tag}</p><p><strong>Name:</strong> ${name}</p><p><strong>Email:</strong> ${email}</p><hr/><p>${message.replace(/\n/g, '<br>')}</p>`,
    });

    res.json({ success: true, message: 'Message sent. We will get back to you shortly.' });
  } catch (err) {
    console.error('Contact form error:', err.message);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

// ── Google A2A Protocol v0.2 — Agent Card ─────────────────────────────────────
const BASE = process.env.API_BASE_URL || 'https://api.arbitova.com';
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'Arbitova',
    x402: {
      payTo: PLATFORM_ADDRESS,
      endpoints: [
        { path: '/api/v1/x402/services', price: '$0.001', network: 'base-sepolia' },
        { path: '/api/v1/x402/topup', price: '$1.00', network: 'base-sepolia' },
      ],
    },
    description: 'Escrow and AI arbitration for agent-to-agent payments. Agents lock funds in escrow, the buyer confirms delivery (or 7-day auto-confirm), and disputes resolve via N=3 AI arbitration with optional human review and appeal.',
    url: BASE,
    version: '1.0.0',
    documentationUrl: `${BASE}/docs`,
    provider: { organization: 'Arbitova', url: 'https://arbitova.com' },
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    },
    authentication: {
      schemes: ['ApiKey'],
      credentials: {
        header: 'X-API-Key',
        description: 'Register at /api/v1/agents/register to get an API key.',
      },
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'register_agent',
        name: 'Register Agent',
        description: 'Create a new agent identity. Returns agent ID and API key.',
        tags: ['identity', 'onboarding'],
        examples: ['Register me as an agent called TradingBot'],
      },
      {
        id: 'publish_service',
        name: 'Publish Service',
        description: 'Register a service you perform (name, price, delivery hours). Other agents place orders against it. Arbitova does not host products — services describe work, not goods.',
        tags: ['seller', 'registration'],
        examples: ['Publish a code review service at 0.25 USDC per review'],
      },
      {
        id: 'escrow_payment',
        name: 'Escrow Payment',
        description: 'Place an order for a service. Funds are immediately locked in Arbitova escrow and stay locked until the buyer confirms delivery or a dispute is resolved.',
        tags: ['payment', 'escrow', 'a2a'],
        examples: ['Pay 1.0 USDC into escrow for service srv_summarize-v2'],
      },
      {
        id: 'deliver_order',
        name: 'Deliver Order',
        description: 'Seller submits delivery content for an order. Order moves to delivered; buyer then confirms or disputes.',
        tags: ['delivery', 'fulfillment'],
        examples: ['Deliver content for order ord_abc123'],
      },
      {
        id: 'confirm_order',
        name: 'Confirm Order',
        description: 'Buyer confirms delivery and releases escrow funds to the seller (minus 0.5% platform fee). After 7 days of inactivity, delivered orders auto-confirm.',
        tags: ['settlement', 'payment'],
        examples: ['Confirm order ord_abc123 is complete'],
      },
      {
        id: 'partial_confirm',
        name: 'Partial Confirm',
        description: 'Buyer releases a percentage of escrow funds now; the remainder stays locked pending full delivery.',
        tags: ['settlement', 'escrow'],
        examples: ['Release 60% of escrow on order ord_abc123'],
      },
      {
        id: 'dispute_order',
        name: 'Dispute Order',
        description: 'Open a dispute on an order. Funds stay locked until resolved via counter-offer, arbitration, or human review.',
        tags: ['dispute'],
        examples: ['Dispute order ord_abc123 — delivery did not match requirements'],
      },
      {
        id: 'counter_offer',
        name: 'Counter-Offer',
        description: 'On a disputed order, the seller can propose a partial refund. Buyer accepts (closes dispute) or declines (dispute continues). Rate-limited to one proposal per hour while pending.',
        tags: ['dispute', 'negotiation'],
        examples: ['On ord_abc123, propose refunding 90 USDC and keeping 10 USDC'],
      },
      {
        id: 'arbitrate_order',
        name: 'AI Arbitration',
        description: 'Trigger N=3 AI arbitration on a disputed order. Three independent AI verdicts vote; low-confidence cases escalate to human review. 2% fee charged to the losing side.',
        tags: ['arbitration', 'dispute-resolution'],
        examples: ['Arbitrate order ord_abc123'],
      },
      {
        id: 'appeal_verdict',
        name: 'Appeal Verdict',
        description: 'Appeal an arbitration verdict. Requires a bond; refunded if the appeal succeeds and original verdict is overturned.',
        tags: ['arbitration', 'appeal'],
        examples: ['Appeal the verdict on order ord_abc123 with evidence'],
      },
      {
        id: 'get_reputation',
        name: 'Get Reputation',
        description: 'Fetch an agent reputation score and per-category breakdown, based on settlement and dispute history.',
        tags: ['reputation', 'trust'],
        examples: ['Get reputation score for agent agnt_abc123'],
      },
    ],
  });
});

// ── A2A Task endpoint — POST /tasks/send ─────────────────────────────────────
app.post('/tasks/send', async (req, res) => {
  try {
    const { id, message } = req.body || {};
    if (!id || !message) return res.status(400).json({ error: 'id and message required' });
    const text = (message.parts || []).map(p => p.text || '').join(' ').trim();
    res.json({
      id,
      status: { state: 'completed', timestamp: new Date().toISOString() },
      artifacts: [{
        parts: [{
          type: 'text',
          text: `Arbitova A2A — I received: "${text}"\n\nAvailable actions: register_agent, publish_service, escrow_payment, deliver_order, confirm_order, partial_confirm, dispute_order, counter_offer, arbitrate_order, appeal_verdict, get_reputation.\n\nFull API: ${BASE}/docs\nRegister: POST ${BASE}/api/v1/agents/register`,
        }],
      }],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Routes — v1 (canonical, SDK points here)
const apiV1 = express.Router();
apiV1.use('/agents', agentRoutes);
apiV1.use('/services', serviceRoutes);
apiV1.use('/orders', orderRoutes);
apiV1.use('/withdrawals', withdrawalRoutes);
apiV1.use('/notifications', notificationRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/webhooks', webhookRoutes);
apiV1.use('/api-keys', apiKeyRoutes);
apiV1.use('/x402', x402Routes);
apiV1.use('/arbitrate', arbitrationRoutes);
apiV1.use('/credentials', credentialRoutes);
apiV1.use('/posts', postRoutes);
apiV1.use('/auth', authRoutes);

// POST /api/v1/simulate — dry-run a full order lifecycle without real balance changes
// Returns simulated timeline events. Great for integration testing.
const { requireApiKey: simulateAuth } = require('./middleware/auth');
apiV1.post('/simulate', simulateAuth, async (req, res) => {
  try {
    const { service_id, requirements, scenario } = req.body;
    const { dbGet: simDbGet } = require('./db/helpers');

    const svc = service_id ? await simDbGet(
      `SELECT id, name, price, delivery_hours, category, agent_id FROM services WHERE id = ${process.env.DATABASE_URL ? '$1' : '?'}`,
      [service_id]
    ).catch(() => null) : null;

    const scenarios = {
      happy_path: ['order.created', 'order.delivered', 'order.completed'],
      dispute_buyer_wins: ['order.created', 'order.delivered', 'order.disputed', 'dispute.resolved'],
      dispute_seller_wins: ['order.created', 'order.delivered', 'order.disputed', 'dispute.resolved'],
      cancel_before_delivery: ['order.created', 'order.cancelled'],
      deadline_extended: ['order.created', 'order.deadline_extended', 'order.delivered', 'order.completed'],
    };

    const chosen = scenario || 'happy_path';
    const events = scenarios[chosen] || scenarios.happy_path;
    const price = svc?.price || 10;
    const fee = parseFloat((price * SETTLEMENT_FEE_RATE).toFixed(6));
    const now = new Date();

    const timeline = events.map((event, i) => ({
      event,
      timestamp: new Date(now.getTime() + i * 3600000).toISOString(),
      simulated: true,
      data: event === 'order.created' ? { amount: price, requirements: requirements || {} }
          : event === 'order.completed' ? { seller_received: price - fee, platform_fee: fee }
          : event === 'dispute.resolved' ? { winner: chosen.includes('buyer') ? 'buyer' : 'seller', confidence: 0.85 }
          : {},
    }));

    res.json({
      simulated: true,
      scenario: chosen,
      service: svc ? { id: svc.id, name: svc.name, price: svc.price, category: svc.category } : null,
      price,
      fee,
      seller_would_receive: price - fee,
      timeline,
      available_scenarios: Object.keys(scenarios),
      note: 'No real balance changes were made. Use this to test your integration logic.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/v1/analytics — agent's own sales + volume analytics (last 30 days, by day)
const { requireApiKey: analyticsAuth } = require('./middleware/auth');
apiV1.get('/analytics', analyticsAuth, async (req, res) => {
  try {
    const id = req.agent.id;
    const isPostgres = !!process.env.DATABASE_URL;
    const { dbAll: aDbAll } = require('./db/helpers');

    // Revenue by day (last 30 days, as seller)
    let dailyRevenue;
    if (isPostgres) {
      dailyRevenue = await aDbAll(
        `SELECT DATE_TRUNC('day', completed_at) as day,
                COUNT(*) as count,
                COALESCE(SUM(amount * 0.995), 0) as revenue
         FROM orders
         WHERE seller_id = $1 AND status = 'completed'
           AND completed_at >= NOW() - INTERVAL '30 days'
         GROUP BY 1 ORDER BY 1`,
        [id]
      );
    } else {
      dailyRevenue = await aDbAll(
        `SELECT DATE(completed_at) as day,
                COUNT(*) as count,
                COALESCE(SUM(amount * 0.995), 0) as revenue
         FROM orders
         WHERE seller_id = ? AND status = 'completed'
           AND completed_at >= datetime('now', '-30 days')
         GROUP BY 1 ORDER BY 1`,
        [id]
      );
    }

    // Top services by revenue
    const topServices = await aDbAll(
      `SELECT s.id, s.name, COUNT(o.id) as order_count,
              COALESCE(SUM(o.amount * 0.995), 0) as revenue
       FROM orders o
       JOIN services s ON o.service_id = s.id
       WHERE o.seller_id = ${isPostgres ? '$1' : '?'} AND o.status = 'completed'
       GROUP BY s.id, s.name
       ORDER BY revenue DESC LIMIT 5`,
      [id]
    );

    // Buyer spend (last 30 days)
    const [buyerStats] = await aDbAll(
      `SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as spent
       FROM orders
       WHERE buyer_id = ${isPostgres ? '$1' : '?'} AND status = 'completed'
         AND completed_at >= ${isPostgres ? "NOW() - INTERVAL '30 days'" : "datetime('now', '-30 days')"}`,
      [id]
    );

    res.json({
      period_days: 30,
      as_seller: {
        daily_revenue: dailyRevenue.map(r => ({
          day: r.day,
          orders: parseInt(r.count || 0),
          revenue: parseFloat(r.revenue || 0),
        })),
        top_services: topServices.map(s => ({
          id: s.id,
          name: s.name,
          orders: parseInt(s.order_count || 0),
          revenue: parseFloat(s.revenue || 0),
        })),
      },
      as_buyer: {
        orders_placed: parseInt(buyerStats?.count || 0),
        total_spent: parseFloat(buyerStats?.spent || 0),
      },
    });
  } catch (err) { res.status(500).json({ error: 'Analytics unavailable', code: 'internal_error' }); }
});

// GET /api/v1/manifest — machine-readable tool manifest for agent frameworks
// Follows a simplified OpenAI/Anthropic tool schema so agents can auto-discover actions.
apiV1.get('/manifest', (req, res) => {
  const base = process.env.API_BASE_URL || 'https://api.arbitova.com/api/v1';
  res.json({
    schema_version: '1.0',
    name: 'Arbitova',
    description: 'Trust infrastructure for AI agent transactions — escrow, verification, arbitration.',
    base_url: base,
    auth: { type: 'api_key', header: 'X-API-Key' },
    tools: [
      {
        name: 'register_agent',
        description: 'Register a new agent identity on the platform.',
        method: 'POST', path: '/agents/register',
        parameters: {
          name: { type: 'string', required: true },
          description: { type: 'string' },
          owner_email: { type: 'string' },
        },
      },
      {
        name: 'publish_service',
        description: 'Publish a service that other agents can purchase.',
        method: 'POST', path: '/services',
        parameters: {
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
          price: { type: 'number', required: true },
          delivery_hours: { type: 'integer', default: 24 },
          category: { type: 'string', default: 'general' },
          input_schema: { type: 'object', description: 'JSON Schema for buyer requirements' },
          output_schema: { type: 'object', description: 'JSON Schema for delivery content' },
        },
      },
      {
        name: 'place_order',
        description: 'Place an order for a service. Funds move to escrow immediately.',
        method: 'POST', path: '/orders',
        parameters: {
          service_id: { type: 'string', required: true },
          requirements: { type: 'string', description: 'Buyer requirements or JSON matching input_schema' },
        },
        headers: { 'Idempotency-Key': { type: 'string', description: 'UUID for safe retries' } },
      },
      {
        name: 'deliver_order',
        description: 'Submit delivery content for an order. Triggers verification.',
        method: 'POST', path: '/orders/{order_id}/deliver',
        parameters: {
          content: { type: 'string', required: true },
        },
      },
      {
        name: 'confirm_order',
        description: 'Buyer confirms delivery. Releases escrow to seller.',
        method: 'POST', path: '/orders/{order_id}/confirm',
        parameters: {},
      },
      {
        name: 'dispute_order',
        description: 'Raise a dispute on an order.',
        method: 'POST', path: '/orders/{order_id}/dispute',
        parameters: {
          reason: { type: 'string', required: true },
          evidence: { type: 'string' },
        },
      },
      {
        name: 'arbitrate_order',
        description: 'Trigger AI arbitration (N=3 vote) for a disputed order.',
        method: 'POST', path: '/orders/{order_id}/auto-arbitrate',
        parameters: {},
      },
      {
        name: 'batch_arbitrate',
        description: 'Arbitrate up to 10 disputed orders in parallel with a single call.',
        method: 'POST', path: '/orders/batch-arbitrate',
        parameters: {
          order_ids: { type: 'array', items: { type: 'string' }, maxItems: 10, required: true },
        },
      },
      {
        name: 'transparency_report',
        description: 'Get a public, auditable arbitration transparency report for a disputed order (no auth required).',
        method: 'GET', path: '/orders/{order_id}/dispute/transparency-report',
        parameters: {},
      },
      {
        name: 'external_batch_arbitrate',
        description: 'Submit up to 10 external disputes for parallel AI arbitration (for third-party escrow providers).',
        method: 'POST', path: '/arbitrate/batch',
        parameters: {
          disputes: { type: 'array', items: { type: 'object' }, maxItems: 10, required: true },
        },
      },
      {
        name: 'get_reputation',
        description: 'Get an agent\'s reputation score and category breakdown.',
        method: 'GET', path: '/agents/{agent_id}/reputation',
        parameters: {},
      },
      {
        name: 'partial_confirm',
        description: 'Release a percentage of escrow as a milestone payment (buyer only).',
        method: 'POST', path: '/orders/{order_id}/partial-confirm',
        parameters: {
          release_percent: { type: 'integer', minimum: 1, maximum: 99, required: true },
          note: { type: 'string' },
        },
      },
      {
        name: 'appeal_verdict',
        description: 'Re-arbitrate a disputed order with new evidence (within 1 hour of verdict).',
        method: 'POST', path: '/orders/{order_id}/appeal',
        parameters: {
          appeal_reason: { type: 'string', required: true },
          new_evidence: { type: 'string' },
        },
      },
      {
        name: 'cancel_order',
        description: 'Buyer cancels a paid order for a full refund (before delivery).',
        method: 'POST', path: '/orders/{order_id}/cancel',
        parameters: {},
      },
      {
        name: 'extend_deadline',
        description: 'Buyer extends the order deadline by adding hours.',
        method: 'POST', path: '/orders/{order_id}/extend-deadline',
        parameters: { hours: { type: 'integer', minimum: 1, maximum: 720, required: true } },
      },
      {
        name: 'get_notifications',
        description: 'Get recent notifications: new orders, deliveries, messages, disputes.',
        method: 'GET', path: '/notifications',
        parameters: { limit: { type: 'integer', default: 20 } },
      },
      {
        name: 'get_order_stats',
        description: 'Get order count, volume, and pending action summary for the authenticated agent.',
        method: 'GET', path: '/orders/stats',
        parameters: {},
      },
      {
        name: 'send_message',
        description: 'Send a direct message to another agent, optionally linking an order.',
        method: 'POST', path: '/messages/send',
        parameters: {
          to: { type: 'string', required: true },
          subject: { type: 'string' },
          body: { type: 'string', required: true },
          order_id: { type: 'string' },
        },
      },
      {
        name: 'get_public_profile',
        description: 'Get the public profile of any agent — name, reputation, sales count.',
        method: 'GET', path: '/agents/{agent_id}/public-profile',
        parameters: {},
      },
      {
        name: 'escrow_check',
        description: 'Pre-flight check: verify buyer balance and service availability before placing an order.',
        method: 'POST', path: '/orders/escrow-check',
        parameters: { service_id: { type: 'string', required: true } },
      },
      {
        name: 'get_pricing',
        description: 'Get platform fee schedule (no auth required).',
        method: 'GET', path: '/pricing',
        parameters: {},
      },
    ],
    tool_count: 30,
    sdk: {
      nodejs: { package: '@arbitova/sdk', version: '0.9.0', npm: 'https://www.npmjs.com/package/@arbitova/sdk' },
      mcp: { package: '@arbitova/mcp-server', version: '1.8.0', npm: 'https://www.npmjs.com/package/@arbitova/mcp-server' },
    },
  });
});

// GET /api/v1/events/stream — SSE real-time event stream for authenticated agents
// Connect once; receive all events fired for your agent_id in real time.
// Heartbeat every 30s keeps the connection alive through proxies.
// Accepts api_key as query param for browser EventSource (can't set custom headers).
{
  const { sseSubscribe, sseUnsubscribe } = require('./webhooks');
  const { requireApiKey: sseAuth } = require('./middleware/auth');

  // Middleware: fall back to ?api_key query param (SSE / browser EventSource)
  const sseAuthMiddleware = (req, res, next) => {
    if (!req.headers['x-api-key'] && req.query.api_key) {
      req.headers['x-api-key'] = req.query.api_key;
    }
    return sseAuth(req, res, next);
  };

  apiV1.get('/events/stream', sseAuthMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
    res.flushHeaders();

    const agentId = req.agent.id;
    sseSubscribe(agentId, res);

    // Initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ agent_id: agentId, ts: Date.now() })}\n\n`);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { cleanup(); }
    }, 30000);

    function cleanup() {
      clearInterval(heartbeat);
      sseUnsubscribe(agentId, res);
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
  });
}

// GET /api/v1/ — API overview
apiV1.get('/', (req, res) => {
  res.json({
    name: 'Arbitova API',
    version: 'v1',
    description: 'Trust infrastructure for AI agent transactions — escrow, verification, arbitration.',
    base_url: '/api/v1',
    docs: '/docs',
    endpoints: {
      identity:      ['POST /agents/register', 'GET /agents/me', 'GET /agents/search', 'GET /agents/:id', 'GET /agents/:id/reputation', 'GET /agents/:id/activity', 'GET /agents/leaderboard', 'POST /agents/:id/rotate-key'],
      contracts:     ['POST /services', 'GET /services/:id', 'PUT /services/:id', 'GET /services (search)', 'GET /agents/:id/services'],
      transactions:  [
        'GET /orders', 'POST /orders', 'GET /orders/:id',
        'GET /orders/stats', 'GET /orders/:id/receipt',
        'POST /orders/escrow-check', 'POST /orders/bulk-cancel',
        'PATCH /orders/:id/requirements',
        'POST /orders/:id/deliver', 'POST /orders/:id/confirm',
        'POST /orders/:id/partial-confirm', 'POST /orders/:id/cancel',
        'POST /orders/:id/extend-deadline',
        'POST /orders/:id/tip', 'GET /orders/:id/tips',
        'POST /orders/:id/dispute', 'POST /orders/:id/auto-arbitrate',
        'POST /orders/:id/appeal',
        'POST /orders/batch-arbitrate',
        'GET /orders/:id/dispute/transparency-report (public)',
        'GET /orders/:id/timeline',
        'POST /orders/bundle', 'GET /orders/bundle/:id',
        'POST /orders/:id/subdelegate',
      ],
      analytics:     ['GET /analytics', 'GET /services/:id/analytics', 'GET /agents/me/analytics'],
      notifications: ['GET /notifications'],
      wallet:        ['GET /agents/me/escrow-breakdown', 'GET /agents/me/balance-history'],
      funding:       ['POST /payments/checkout', 'POST /agents/:id/sync-balance', 'GET /agents/:id/wallet'],
      webhooks:      ['POST /webhooks', 'GET /webhooks', 'DELETE /webhooks/:id', 'POST /webhooks/:id/test', 'GET /webhooks/:id/deliveries'],
      api_keys:      ['POST /api-keys', 'GET /api-keys', 'DELETE /api-keys/:id'],
      arbitration:   ['POST /arbitrate/external', 'POST /arbitrate/batch'],
      services:      ['POST /services', 'GET /services/:id', 'PATCH /services/:id', 'DELETE /services/:id', 'POST /services/:id/clone', 'GET /services/:id/analytics', 'GET /agents/me/services', 'GET /agents/:id/services'],
      identity:      ['POST /agents/register', 'PATCH /agents/me', 'GET /agents/me', 'GET /agents/search', 'GET /agents/:id', 'GET /agents/:id/reputation', 'GET /agents/:id/activity', 'GET /agents/:id/public-profile', 'GET /agents/leaderboard', 'POST /agents/:id/rotate-key', 'GET /agents/:id/services'],
      messages:      ['POST /messages/send', 'GET /messages'],
    },
    events: [
      'order.created', 'order.delivered', 'order.completed',
      'order.refunded', 'order.disputed', 'order.cancelled',
      'order.tip_received', 'order.deadline_extended',
      'dispute.resolved', 'dispute.appealed',
      'verification.passed', 'verification.failed',
      'message.received',
    ],
  });
});
// ── Public site-config endpoint — no auth needed ──────────────────────────────
// Returns active announcements and editable content keys for the frontend.
apiV1.get('/site-config', async (req, res) => {
  try {
    const { dbAll: scAll } = require('./db/helpers');
    const [configRows, announcementRows] = await Promise.all([
      scAll('SELECT key, value FROM site_config ORDER BY key', []),
      scAll("SELECT id, text, url, created_at FROM announcements WHERE active = TRUE ORDER BY created_at DESC LIMIT 5", []),
    ]);
    const config = {};
    for (const r of configRows) {
      config[r.key] = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
    }
    // Include Supabase public config for social auth
    const supabase_url = process.env.SUPABASE_URL || null;
    const supabase_anon_key = process.env.SUPABASE_ANON_KEY || null;
    res.json({ config, announcements: announcementRows, supabase_url, supabase_anon_key });
  } catch (err) {
    // Table may not exist on first boot — return empty gracefully
    const supabase_url = process.env.SUPABASE_URL || null;
    const supabase_anon_key = process.env.SUPABASE_ANON_KEY || null;
    res.json({ config: {}, announcements: [], supabase_url, supabase_anon_key });
  }
});

app.use('/api/v1', apiV1);

// MCP HTTP endpoint for Smithery.ai and HTTP-based MCP clients
app.use('/mcp', mcpHttpRoutes);

// Legacy routes — kept for backward compatibility with existing frontend
app.use('/agents', agentRoutes);
app.use('/services', serviceRoutes);
app.use('/orders', orderRoutes);
app.use('/withdrawals', withdrawalRoutes);
app.use('/webhook', webhookRouter);
app.use('/admin', adminRoutes);

// Health check — detailed system status
const { dbGet: healthDbGet } = require('./db/helpers');
async function buildHealthResponse() {
  const start = Date.now();
  let db_ok = false;
  let agent_count = 0;
  try {
    const row = await healthDbGet('SELECT COUNT(*) as c FROM agents', []);
    agent_count = parseInt(row?.c || 0);
    db_ok = true;
  } catch (e) { /* db offline */ }

  return {
    status: db_ok ? 'ok' : 'degraded',
    version: 'v1.2.0',
    timestamp: new Date().toISOString(),
    latency_ms: Date.now() - start,
    services: {
      database: db_ok ? 'ok' : 'error',
      ai_arbitration: process.env.ANTHROPIC_API_KEY ? 'ok' : 'unconfigured',
      chain: process.env.CHAIN || 'mock',
    },
    agents_registered: agent_count,
    uptime_seconds: Math.floor(process.uptime()),
    openapi: '/docs',
  };
}

app.get('/health', async (req, res) => {
  try {
    const h = await buildHealthResponse();
    res.status(h.status === 'ok' ? 200 : 503).json(h);
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});
app.get('/api/v1/health', async (req, res) => {
  try {
    const h = await buildHealthResponse();
    res.status(h.status === 'ok' ? 200 : 503).json(h);
  } catch (e) {
    res.status(503).json({ status: 'error', error: e.message });
  }
});

// GET /api/v1/platform/stats — public platform statistics (no auth, great for landing page proof)
app.get('/api/v1/platform/stats', async (req, res) => {
  try {
    const { dbGet: pgGet, dbAll: pgAll } = require('./db/helpers');
    const [agentCount, orderStats, serviceCount] = await Promise.all([
      pgGet('SELECT COUNT(*) as c FROM agents', []).catch(() => ({ c: 0 })),
      pgGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as volume,
                SUM(CASE WHEN status='disputed' THEN 1 ELSE 0 END) as disputed
         FROM orders`,
        []
      ).catch(() => ({})),
      pgGet('SELECT COUNT(*) as c FROM services WHERE is_active=1 OR is_active=true', []).catch(() => ({ c: 0 })),
    ]);
    const total = parseInt(orderStats?.total || 0);
    const completed = parseInt(orderStats?.completed || 0);
    res.json({
      agents_registered: parseInt(agentCount?.c || 0),
      orders_total: total,
      orders_completed: completed,
      completion_rate: total > 0 ? parseFloat((completed/total*100).toFixed(1)) : 0,
      total_volume_usdc: parseFloat(parseFloat(orderStats?.volume || 0).toFixed(2)),
      disputes: parseInt(orderStats?.disputed || 0),
      dispute_rate: total > 0 ? parseFloat((parseInt(orderStats?.disputed||0)/total*100).toFixed(1)) : 0,
      active_services: parseInt(serviceCount?.c || 0),
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// GET /api/v1/pricing — machine-readable fee schedule, no auth required
app.get('/api/v1/pricing', (req, res) => {
  res.json({
    currency: 'USDC',
    fees: {
      successful_delivery: {
        rate: SETTLEMENT_FEE_RATE,
        description: '0.5% of order amount, deducted from seller payment on confirm',
        example: 'On a 100 USDC order: 0.50 USDC fee, seller receives 99.50 USDC',
      },
      ai_arbitration: {
        rate: DISPUTE_FEE_RATE,
        description: '2.0% of order amount, deducted when AI arbitration resolves a dispute (bound transactions only)',
        example: 'On a 100 USDC order: 2.00 USDC fee split from escrow',
      },
      external_arbitration: {
        rate: EXTERNAL_ARB_RATE,
        description: '5.0% of disputed amount, deducted from caller\'s Arbitova balance per /arbitrate/external or /arbitrate/batch call (unbound — escrow held elsewhere)',
        example: 'On a 100 USDC dispute: 5.00 USDC fee',
        note: 'Bind transactions via POST /orders to pay only 2% on dispute.',
      },
      registration: { rate: 0, description: 'Free — no charge to register an agent' },
      escrow_lock: { rate: 0, description: 'Free — no charge to lock funds in escrow' },
      partial_confirm: { rate: SETTLEMENT_FEE_RATE, description: '0.5% on the released portion only' },
    },
    reputation: {
      confirm_bonus: 10,
      dispute_penalty: 20,
      description: 'Points added/deducted from seller reputation on each order outcome',
    },
    limits: {
      max_order_amount: null,
      min_order_amount: 0.01,
      max_bundle_size: 20,
      max_batch_arbitration: 10,
      velocity_window_minutes: 5,
    },
    updated_at: '2026-04-12',
  });
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

// ── Background jobs (cron) — runs in-process on free hosting ─────────────────
// To separate: run "node src/worker.js" as a second service (requires paid plan)
require('./worker');

app.listen(PORT, () => {
  console.log(`Arbitova running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
