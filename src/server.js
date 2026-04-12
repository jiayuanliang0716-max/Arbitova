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
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const apiKeyRoutes = require('./routes/apikeys');
const { router: x402Routes, PLATFORM_ADDRESS } = require('./routes/x402route');
const arbitrationRoutes = require('./routes/arbitration');
const requestRoutes = require('./routes/requests');
const credentialRoutes = require('./routes/credentials');
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

// Static frontend (SPA — public/index.html is served at /)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Clean URL aliases for standalone pages
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'profile.html')));
app.get('/badge', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'badge.html')));

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
      dbAll('SELECT COUNT(*) as count FROM services WHERE is_active = true OR is_active = 1', []),
      dbAll(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as vol FROM orders WHERE status = ${p(1)}`, ['completed']),
      dbAll(`SELECT COUNT(*) as count FROM orders WHERE status = ${p(1)}`, ['disputed']),
      dbAll(`SELECT COALESCE(SUM(amount), 0) as vol FROM orders WHERE status NOT IN (${p(2)},${p(3)})`, ['cancelled', 'refunded']),
    ]);
    statsCache = {
      agents: parseInt(agents[0].count),
      services: parseInt(services[0].count),
      completed_orders: parseInt(completed[0].count),
      active_disputes: parseInt(disputed[0].count),
      total_volume: parseFloat(total_vol[0].vol || 0),
      platform_fees: parseFloat(completed[0].vol || 0) * 0.005,
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
apiV1.use('/notifications', notificationRoutes);
apiV1.use('/admin', adminRoutes);
apiV1.use('/webhooks', webhookRoutes);
apiV1.use('/api-keys', apiKeyRoutes);
apiV1.use('/x402', x402Routes);
apiV1.use('/arbitrate', arbitrationRoutes);
apiV1.use('/requests', requestRoutes);
apiV1.use('/credentials', credentialRoutes);

// POST /api/v1/recommend — AI-powered service recommendation for a buyer task description
const { requireApiKey: recAuth } = require('./middleware/auth');
apiV1.post('/recommend', recAuth, async (req, res) => {
  try {
    const { task, budget, category } = req.body;
    if (!task || !task.trim()) return res.status(400).json({ error: 'task description is required' });
    if (task.length > 2000) return res.status(400).json({ error: 'task must be 2000 chars or less' });

    const { dbAll: recDbAll } = require('./db/helpers');
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';

    // Fetch active services (with seller reputation)
    let query = `SELECT s.id, s.name, s.description, s.price, s.category, s.delivery_hours,
                        a.name as agent_name, COALESCE(a.reputation_score, 0) as rep
                 FROM services s JOIN agents a ON a.id = s.agent_id
                 WHERE s.is_active = ${isPostgres ? 'true' : '1'}`;
    const params = [];
    let pi = 1;
    if (category) { query += ` AND s.category = ${p(pi++)}`; params.push(category); }
    if (budget) { query += ` AND s.price <= ${p(pi++)}`; params.push(parseFloat(budget)); }
    query += ` ORDER BY COALESCE(a.reputation_score, 0) DESC LIMIT 30`;
    params.push();

    const services = await recDbAll(query, params);
    if (!services.length) return res.json({ task, recommendations: [], message: 'No matching services found.' });

    if (!process.env.ANTHROPIC_API_KEY) {
      // Fallback: keyword-based ranking
      const keywords = task.toLowerCase().split(/\s+/);
      const scored = services.map(s => {
        const text = `${s.name} ${s.description || ''} ${s.category}`.toLowerCase();
        const matches = keywords.filter(k => text.includes(k)).length;
        return { ...s, score: matches + parseInt(s.rep) / 100 };
      }).sort((a, b) => b.score - a.score).slice(0, 5);
      return res.json({ task, method: 'keyword', recommendations: scored.map(s => ({ id: s.id, name: s.name, price: parseFloat(s.price), category: s.category, agent: s.agent_name, reason: 'Keyword match' })) });
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const catalog = services.slice(0, 15).map((s, i) => `${i+1}. [${s.id}] ${s.name} (${s.category}, ${s.price} USDC, ${s.delivery_hours}h) — ${(s.description || '').slice(0, 100)}`).join('\n');

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Task: "${task}"\nBudget: ${budget ? budget + ' USDC' : 'any'}\n\nAvailable services:\n${catalog}\n\nReturn ONLY a JSON array of up to 3 service IDs with one-line reasons: [{"id":"...","reason":"..."}]`,
      }],
    });

    let picks = [];
    try {
      const text = msg.content?.[0]?.text || '[]';
      const match = text.match(/\[[\s\S]*\]/);
      picks = JSON.parse(match ? match[0] : '[]');
    } catch (e) { picks = []; }

    const result = picks.slice(0, 3).map(p => {
      const svc = services.find(s => s.id === p.id);
      if (!svc) return null;
      return { id: svc.id, name: svc.name, price: parseFloat(svc.price), category: svc.category, delivery_hours: svc.delivery_hours, agent: svc.agent_name, reason: p.reason };
    }).filter(Boolean);

    res.json({ task, method: 'ai', budget: budget || null, recommendations: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/simulate — dry-run a full order lifecycle without real balance changes
// Returns simulated timeline events. Great for integration testing.
const { requireApiKey: simulateAuth } = require('./middleware/auth');
apiV1.post('/simulate', simulateAuth, async (req, res) => {
  try {
    const { service_id, requirements, scenario } = req.body;
    const { dbGet: simDbGet } = require('./db/helpers');

    const svc = service_id ? await simDbGet(
      `SELECT id, name, price, delivery_hours, category, auto_verify, agent_id FROM services WHERE id = ${process.env.DATABASE_URL ? '$1' : '?'}`,
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
    const fee = parseFloat((price * 0.005).toFixed(6));
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
    const [agentCount, orderStats, reviewStats, serviceCount] = await Promise.all([
      pgGet('SELECT COUNT(*) as c FROM agents', []).catch(() => ({ c: 0 })),
      pgGet(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as volume,
                SUM(CASE WHEN status='disputed' THEN 1 ELSE 0 END) as disputed
         FROM orders`,
        []
      ).catch(() => ({})),
      pgGet('SELECT COUNT(*) as c, AVG(rating) as avg FROM reviews', []).catch(() => ({ c: 0, avg: null })),
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
      reviews_total: parseInt(reviewStats?.c || 0),
      avg_rating: reviewStats?.avg ? parseFloat(parseFloat(reviewStats.avg).toFixed(2)) : null,
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
        rate: 0.005,
        description: '0.5% of order amount, deducted from seller payment on confirm',
        example: 'On a 100 USDC order: 0.50 USDC fee, seller receives 99.50 USDC',
      },
      ai_arbitration: {
        rate: 0.02,
        description: '2.0% of order amount, deducted when AI arbitration resolves a dispute',
        example: 'On a 100 USDC order: 2.00 USDC fee split from escrow',
      },
      registration: { rate: 0, description: 'Free — no charge to register an agent' },
      escrow_lock: { rate: 0, description: 'Free — no charge to lock funds in escrow' },
      partial_confirm: { rate: 0.005, description: '0.5% on the released portion only' },
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

// GET /api/v1/agents/discover — A2A agent discovery (pure A2A, no auth)
// Find agents that can fulfill a task, filtered by capability/category, price, and minimum trust score.
// Designed for autonomous agent use: buyer agent calls this before placing an order.
// Query params: capability (keyword), category, max_price, min_trust (0-100), sort (trust|price|reputation), limit
app.get('/api/v1/agents/discover', async (req, res) => {
  try {
    const { dbAll: pgAll } = require('./db/helpers');
    const capability = req.query.capability || req.query.q;
    const category   = req.query.category;
    const maxPrice   = parseFloat(req.query.max_price) || null;
    const minTrust   = parseInt(req.query.min_trust) || 0;
    const sort       = req.query.sort || 'trust'; // trust|price|reputation
    const limit      = Math.min(parseInt(req.query.limit) || 10, 50);

    // Build service filter
    const svcConditions = ['s.is_active = 1 OR s.is_active = true'];
    const svcParams = [];
    let idx = 1;

    if (capability) {
      svcConditions.push(`(s.name LIKE $${idx} OR s.description LIKE $${idx + 1})`);
      svcParams.push(`%${capability}%`, `%${capability}%`);
      idx += 2;
    }
    if (category) {
      svcConditions.push(`s.category = $${idx}`);
      svcParams.push(category);
      idx++;
    }
    if (maxPrice !== null) {
      svcConditions.push(`s.price <= $${idx}`);
      svcParams.push(maxPrice);
      idx++;
    }

    const isPostgres = !!process.env.DATABASE_URL;
    const ph = (n) => isPostgres ? `$${n}` : '?';

    // Re-build with correct placeholder syntax
    const svcConds2 = ['(s.is_active = 1 OR s.is_active = true)'];
    const svcP2 = [];
    let i2 = 1;
    if (capability) {
      svcConds2.push(`(s.name LIKE ${ph(i2)} OR s.description LIKE ${ph(i2+1)})`);
      svcP2.push(`%${capability}%`, `%${capability}%`);
      i2 += 2;
    }
    if (category) {
      svcConds2.push(`s.category = ${ph(i2)}`);
      svcP2.push(category);
      i2++;
    }
    if (maxPrice !== null) {
      svcConds2.push(`s.price <= ${ph(i2)}`);
      svcP2.push(maxPrice);
      i2++;
    }

    const services = await pgAll(
      `SELECT s.id as service_id, s.name as service_name, s.description as service_desc,
              s.price, s.delivery_hours, s.category, s.auto_verify, s.input_schema,
              a.id as agent_id, a.name as agent_name, a.description as agent_desc,
              COALESCE(a.reputation_score, 0) as reputation_score,
              a.created_at as agent_since,
              (SELECT COUNT(*) FROM orders o WHERE o.seller_id = a.id AND o.status = 'completed') as completed_sales,
              (SELECT COUNT(*) FROM orders o WHERE o.seller_id = a.id) as total_sales,
              (SELECT COUNT(*) FROM orders o WHERE o.seller_id = a.id AND o.status IN ('disputed','refunded')) as disputes,
              (SELECT AVG(rating) FROM reviews r WHERE r.seller_id = a.id) as avg_rating,
              (SELECT COUNT(*) FROM reviews r WHERE r.seller_id = a.id) as review_count
       FROM services s
       JOIN agents a ON s.agent_id = a.id
       WHERE ${svcConds2.join(' AND ')}
       ORDER BY COALESCE(a.reputation_score, 0) DESC
       LIMIT ${ph(i2)}`,
      [...svcP2, limit * 5] // fetch extra to filter by trust
    );

    // Compute trust score inline
    function computeTrust(row) {
      const total = parseInt(row.total_sales || 0);
      const completed = parseInt(row.completed_sales || 0);
      const disputed = parseInt(row.disputes || 0);
      const rep = parseInt(row.reputation_score || 0);
      const avgR = parseFloat(row.avg_rating || 0);
      const nRev = parseInt(row.review_count || 0);
      const ageDays = Math.min((Date.now() - new Date(row.agent_since).getTime()) / 86400000, 30);
      const cr = total > 0 ? completed / total : 0;
      const dr = total > 0 ? disputed / total : 0;
      const raw = Math.min(Math.max(rep, 0) / 200 * 30
        + cr * 25 - Math.min(dr * 40, 20)
        + (nRev > 0 ? (avgR / 5) * 25 : 12.5)
        + (ageDays / 30) * 10
        + Math.min(nRev * 0.5, 10), 100);
      return Math.max(Math.round(raw), 0);
    }
    function trustLevel(s) {
      if (s >= 90) return 'Elite';
      if (s >= 70) return 'Trusted';
      if (s >= 45) return 'Rising';
      return 'New';
    }

    let results = services.map(row => {
      const trust_score = computeTrust(row);
      return {
        agent_id: row.agent_id,
        agent_name: row.agent_name,
        agent_description: row.agent_desc,
        trust_score,
        trust_level: trustLevel(trust_score),
        reputation_score: parseInt(row.reputation_score || 0),
        completed_sales: parseInt(row.completed_sales || 0),
        avg_rating: row.avg_rating ? parseFloat(parseFloat(row.avg_rating).toFixed(2)) : null,
        service: {
          id: row.service_id,
          name: row.service_name,
          description: row.service_desc,
          price_usdc: row.price,
          delivery_hours: row.delivery_hours,
          category: row.category,
          auto_verify: !!(row.auto_verify),
          input_schema: row.input_schema
            ? (typeof row.input_schema === 'string' ? (() => { try { return JSON.parse(row.input_schema); } catch { return null; } })() : row.input_schema)
            : null,
        },
      };
    });

    // Apply min_trust filter
    if (minTrust > 0) results = results.filter(r => r.trust_score >= minTrust);

    // Sort
    if (sort === 'price') {
      results.sort((a, b) => a.service.price_usdc - b.service.price_usdc);
    } else if (sort === 'reputation') {
      results.sort((a, b) => b.reputation_score - a.reputation_score);
    } else {
      results.sort((a, b) => b.trust_score - a.trust_score);
    }

    results = results.slice(0, limit);

    res.json({
      count: results.length,
      filters: {
        capability: capability || null,
        category: category || null,
        max_price: maxPrice,
        min_trust: minTrust || null,
        sort,
      },
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
