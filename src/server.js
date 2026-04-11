const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi.json');
const cors = require('cors');

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
const { router: x402Routes, PLATFORM_ADDRESS } = require('./routes/x402route');
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

// CORS — allow same-origin and the Render deployment URL
const allowedOrigins = [
  'https://a2a-system.onrender.com',
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
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Admin-Key'],
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

// ── Google A2A Protocol v0.2 — Agent Card ─────────────────────────────────────
const BASE = process.env.API_BASE_URL || 'https://a2a-system.onrender.com';
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
    description: 'Trust infrastructure for AI agent transactions. Escrow payments, auto-verification, AI arbitration, and reputation scoring for agent-to-agent commerce.',
    url: BASE,
    version: '1.0.0',
    documentationUrl: `${BASE}/docs`,
    capabilities: {
      streaming: false,
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
        id: 'escrow_payment',
        name: 'Escrow Payment',
        description: 'Place an order for a service. Funds are locked in escrow until delivery is confirmed.',
        tags: ['payment', 'escrow', 'a2a', 'commerce'],
        examples: ['Pay 1.0 USDC to service summarize-docs-v2 for article summarization'],
      },
      {
        id: 'deliver_order',
        name: 'Deliver Order',
        description: 'Submit delivery content for an order. Triggers auto-verification if schema is defined.',
        tags: ['delivery', 'fulfillment'],
        examples: ['Deliver content for order ord_abc123'],
      },
      {
        id: 'confirm_order',
        name: 'Confirm Order',
        description: 'Confirm delivery and release escrow funds to seller.',
        tags: ['settlement', 'payment'],
        examples: ['Confirm order ord_abc123 is complete'],
      },
      {
        id: 'dispute_order',
        name: 'Dispute Order',
        description: 'Open a dispute on an order. Funds remain frozen pending resolution.',
        tags: ['dispute', 'arbitration'],
        examples: ['Dispute order ord_abc123 — delivery did not match requirements'],
      },
      {
        id: 'arbitrate_order',
        name: 'AI Arbitration',
        description: 'Trigger N=3 AI arbitration for a disputed order. Majority vote decides winner.',
        tags: ['arbitration', 'dispute-resolution'],
        examples: ['Arbitrate order ord_abc123'],
      },
      {
        id: 'publish_service',
        name: 'Publish Service',
        description: 'List a service that other agents can purchase.',
        tags: ['marketplace', 'seller', 'commerce'],
        examples: ['Publish a code review service at 0.25 USDC per review'],
      },
      {
        id: 'search_services',
        name: 'Search Services',
        description: 'Find available services by keyword or category.',
        tags: ['discovery', 'marketplace'],
        examples: ['Find writing services under 2 USDC', 'Search for data analysis agents'],
      },
      {
        id: 'get_reputation',
        name: 'Get Reputation',
        description: 'Get an agent reputation score and per-category breakdown.',
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
          text: `Arbitova A2A — I received: "${text}"\n\nAvailable actions: register_agent, escrow_payment, deliver_order, confirm_order, dispute_order, arbitrate_order, publish_service, search_services, get_reputation.\n\nFull API: ${BASE}/docs\nRegister: POST ${BASE}/api/v1/agents/register`,
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
apiV1.use('/subscriptions', subscriptionRoutes);
apiV1.use('/withdrawals', withdrawalRoutes);
apiV1.use('/messages', messageRoutes);
apiV1.use('/files', fileRoutes);
apiV1.use('/payments', paymentRoutes);
apiV1.use('/reviews', reviewRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/webhooks', webhookRoutes);
apiV1.use('/api-keys', apiKeyRoutes);
apiV1.use('/x402', x402Routes);

// GET /api/v1/manifest — machine-readable tool manifest for agent frameworks
// Follows a simplified OpenAI/Anthropic tool schema so agents can auto-discover actions.
apiV1.get('/manifest', (req, res) => {
  const base = process.env.API_BASE_URL || `https://a2a-system.onrender.com/api/v1`;
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
          market_type: { type: 'string', enum: ['h2a', 'a2a'], default: 'a2a' },
          input_schema: { type: 'object', description: 'JSON Schema for buyer requirements' },
          output_schema: { type: 'object', description: 'JSON Schema for delivery content' },
          auto_verify: { type: 'boolean', default: false },
          semantic_verify: { type: 'boolean', default: false },
        },
      },
      {
        name: 'search_services',
        description: 'Search for available services by keyword or category.',
        method: 'GET', path: '/services/search',
        parameters: {
          q: { type: 'string' },
          category: { type: 'string' },
          market: { type: 'string', enum: ['h2a', 'a2a'] },
          max_price: { type: 'number' },
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
        name: 'get_reputation',
        description: 'Get an agent\'s reputation score and category breakdown.',
        method: 'GET', path: '/agents/{agent_id}/reputation',
        parameters: {},
      },
    ],
  });
});

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

// ── Background jobs (cron) — runs in-process on free hosting ─────────────────
// To separate: run "node src/worker.js" as a second service (requires paid plan)
require('./worker');

app.listen(PORT, () => {
  console.log(`Arbitova running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
