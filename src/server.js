const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const nodemailer = require('nodemailer');

require('./db/schema');

const adminRoutes = require('./routes/admin');
const arbitrationRoutes = require('./routes/arbitration');
// const credentialRoutes = require('./routes/credentials');
const mcpHttpRoutes = require('./routes/mcp-http');
const postRoutes = require('./routes/posts');
// const authRoutes = require('./routes/auth');
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
app.get('/verdicts', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'verdicts.html')));
// Per-case verdict bundle (transparency-policy v1.1): /verdicts/{escrowId}
// Frontend reads the specific escrow's on-chain events via ethers.js; policy body
// documents which fields are on-chain today vs populated after off-chain arbitration.
app.get('/verdicts/:disputeId', (req, res, next) => {
  if (!/^\d+$/.test(req.params.disputeId)) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'verdict.html'));
});
app.get('/status',   (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'status.html')));
app.get('/admin',    (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// Path A — /api/mode + Swagger UI disabled (2026-04-23).
// Path A is deprecated; non-custodial Path B has no server-side keys.
// Source kept in v2-path-a-legacy tag.
/*
app.get('/api/mode', (req, res) => {
  res.json({
    chain_mode: !!(process.env.ALCHEMY_API_KEY && process.env.WALLET_ENCRYPTION_KEY),
    has_alchemy: !!process.env.ALCHEMY_API_KEY,
    has_enc_key: !!process.env.WALLET_ENCRYPTION_KEY,
    chain: process.env.CHAIN || 'base-sepolia'
  });
});
app.use('/api-reference', swaggerUi.serve, swaggerUi.setup(openApiSpec));
*/

// Quick Start Docs
app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'docs.html')));

// System Architecture
app.get('/architecture', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'architecture.html')));

// Pricing
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'pricing.html')));
app.get('/fees', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'pricing.html')));
app.get('/claim', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'claim.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'blog.html')));
app.get('/arbiter', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'arbiter.html')));

// ── SSE event stream (EscrowV1 events, fanned out by address) ────────────────
const { sseHandler: arbitovaSSEHandler } = require('./events_sse');
app.get('/events', arbitovaSSEHandler);

// ── Demo seller bot (opt-in via env) ─────────────────────────────────────────
// Publishes bot address + max amount so the UI can offer a "Use our demo seller"
// pill on /pay/new.html, letting users test the full flow without a counterparty.
app.get('/demo-seller-info', (req, res) => {
  const enabled = process.env.DEMO_SELLER_ENABLED === '1'
    && !!process.env.DEMO_SELLER_PK
    && !!process.env.DEMO_SELLER_ADDR;
  res.json({
    enabled,
    address: enabled ? process.env.DEMO_SELLER_ADDR : null,
    maxUsdc: Number(process.env.DEMO_MAX_USDC || '10'),
    description: enabled
      ? 'An Arbitova-operated demo seller that auto-delivers within 30–90s. Use to test the full flow end-to-end with a single wallet. Testnet only.'
      : null,
  });
});

// ── Agent Card ────────────────────────────────────────────────────────────────
// Describes Arbitova to agent crawlers. Source of truth: EscrowV1 on Base Sepolia.
const BASE = process.env.API_BASE_URL || 'https://arbitova.com';
const ESCROW_V1_PROD = '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC';
const USDC_PROD      = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
app.get('/.well-known/agent.json', (req, res) => {
  res.json({
    name: 'Arbitova',
    description: 'Non-custodial USDC escrow for agent-to-agent payments. Buyer locks USDC into an on-chain contract on Base, seller delivers, the contract releases. If disputed, a designated arbiter splits the funds with a public verdict hash.',
    url: BASE,
    version: '2.0.0',
    documentationUrl: `${BASE}/docs`,
    provider: { organization: 'Arbitova', url: 'https://arbitova.com' },
    contract: {
      chain: 'base-sepolia',
      chainId: 84532,
      escrow: ESCROW_V1_PROD,
      usdc: USDC_PROD,
      fees: { releaseBps: 50, resolveBps: 200 },
    },
    authentication: {
      schemes: ['EthereumSignature'],
      credentials: {
        description: 'No registration, no API keys. Agents sign transactions from their own Ethereum address using any EIP-1193 wallet or private key.',
      },
    },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'create_escrow',
        name: 'Create Escrow',
        description: 'Buyer approves USDC, then calls createEscrow(seller, amount, deliveryWindowSec, reviewWindowSec, verificationURI). Funds move from buyer wallet into EscrowV1. Returns escrow id.',
        tags: ['buyer', 'escrow'],
        examples: ['Lock 5 USDC to 0xSeller, 24h delivery, 24h review, spec at ipfs://...'],
      },
      {
        id: 'mark_delivered',
        name: 'Mark Delivered',
        description: 'Seller calls markDelivered(id, deliveryHash). deliveryHash is keccak256 of the payload URI. Opens the review window.',
        tags: ['seller', 'delivery'],
        examples: ['Mark escrow 17 delivered with hash 0x...'],
      },
      {
        id: 'confirm_delivery',
        name: 'Confirm Delivery',
        description: 'Buyer calls confirmDelivery(id). Contract pays seller (minus 0.5% release fee) atomically. Happy path settlement.',
        tags: ['buyer', 'settlement'],
        examples: ['Confirm delivery on escrow 17'],
      },
      {
        id: 'dispute',
        name: 'Dispute',
        description: 'Either party calls dispute(id, reason) during the review window. Funds stay locked until the arbiter calls resolve(). Reason is emitted in the Disputed event.',
        tags: ['dispute'],
        examples: ['Dispute escrow 17 — delivery does not match spec'],
      },
      {
        id: 'cancel_if_not_delivered',
        name: 'Cancel If Not Delivered',
        description: 'Buyer calls cancelIfNotDelivered(id) after the delivery deadline if seller never marked delivered. Full refund to buyer.',
        tags: ['buyer', 'timeout'],
        examples: ['Cancel escrow 17 — seller did not deliver in time'],
      },
      {
        id: 'escalate_if_expired',
        name: 'Escalate If Expired',
        description: 'Anyone calls escalateIfExpired(id) after the review deadline on a DELIVERED escrow. Contract pays seller (minus 0.5% release fee). Prevents deadlock when buyer goes silent.',
        tags: ['auto-release'],
        examples: ['Escalate escrow 17 — buyer did not confirm or dispute in time'],
      },
    ],
  });
});

// Routes — v1
// Path A mounts disabled 2026-04-23. Source in v2-path-a-legacy tag.
// Kept mounted: /admin (site-config, announcements), /arbitrate (GET /verdicts),
// /posts (blog). These have Path B-relevant handlers inside.
const apiV1 = express.Router();
// apiV1.use('/agents', agentRoutes);
// apiV1.use('/services', serviceRoutes);
// apiV1.use('/orders', orderRoutes);
// apiV1.use('/withdrawals', withdrawalRoutes);
// apiV1.use('/notifications', notificationRoutes);
apiV1.use('/admin', adminRoutes);
// apiV1.use('/webhooks', webhookRoutes);
// apiV1.use('/api-keys', apiKeyRoutes);
// apiV1.use('/x402', x402Routes);
apiV1.use('/arbitrate', arbitrationRoutes);
// apiV1.use('/credentials', credentialRoutes);
apiV1.use('/posts', postRoutes);
// apiV1.use('/auth', authRoutes);

// Path A — /simulate, /analytics, /manifest disabled 2026-04-23.
// Source in v2-path-a-legacy tag.
/*
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
*/

// GET /api/v1/ — API overview
/*
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
      arbitration:   ['GET /arbitrate/verdicts'],
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
*/
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

// Alchemy Address Activity webhook (Path A agent-wallet inbound deposits)
// Path A — disabled 2026-04-23. No custody, no deposits.
// app.use('/webhook', webhookRouter);

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

// Path A — /platform/stats + /pricing disabled 2026-04-23 (query Path A tables).
// Source in v2-path-a-legacy tag.
/*
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
*/

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

// ── Background jobs (cron) — Path A disabled 2026-04-23 ───────────────────────
// Path A cron (order expiry, auto-arbitrate) no longer runs. Path B has its
// own worker in src/path_b/worker.js (started by indexer or separate process).
// require('./worker');

// ── Demo seller bot (auto-deliver for single-wallet testing) ─────────────────
const { startDemoSellerBot } = require('./demo_seller_bot');
startDemoSellerBot();

app.listen(PORT, () => {
  console.log(`Arbitova running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
