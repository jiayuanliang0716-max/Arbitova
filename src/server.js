const express = require('express');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi.json');

// 初始化資料庫（必須在 routes 之前）
require('./db/schema');

const agentRoutes = require('./routes/agents');
const serviceRoutes = require('./routes/services');
const orderRoutes = require('./routes/orders');
const telegramRoutes = require('./routes/telegram');
const { dbGet } = require('./db/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Rate limiting：每個 IP 每分鐘最多 60 次請求
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please slow down.' }
}));

// Dashboard
app.get('/', async (req, res) => {
  try {
    const { dbAll } = require('./db/helpers');
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';

    const [agents, services, orders] = await Promise.all([
      dbAll('SELECT COUNT(*) as count FROM agents', []),
      dbAll('SELECT COUNT(*) as count FROM services', []),
      dbAll(`SELECT COUNT(*) as count, COALESCE(SUM(amount * 0.025), 0) as fees FROM orders WHERE status = ${p(1)}`, ['completed'])
    ]);

    const agentCount = agents[0].count;
    const serviceCount = services[0].count;
    const orderCount = orders[0].count;
    const totalFees = parseFloat(orders[0].fees || 0).toFixed(4);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>A2A Trading System</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; min-height: 100vh; padding: 40px 20px; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; color: #fff; }
    .subtitle { color: #666; margin-bottom: 40px; font-size: 14px; }
    .subtitle a { color: #4f8ef7; text-decoration: none; }
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 40px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 24px; }
    .card .value { font-size: 36px; font-weight: 700; color: #fff; margin-bottom: 4px; }
    .card .label { font-size: 13px; color: #666; }
    .section { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px; padding: 24px; margin-bottom: 16px; }
    .section h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #aaa; text-transform: uppercase; letter-spacing: 0.5px; }
    .endpoint { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #222; }
    .endpoint:last-child { border-bottom: none; }
    .method { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; min-width: 48px; text-align: center; }
    .get { background: #1a3a2a; color: #4caf82; }
    .post { background: #1a2a3a; color: #4f8ef7; }
    .patch { background: #2a2a1a; color: #f7c94f; }
    .path { font-family: monospace; font-size: 13px; color: #ccc; }
    .desc { font-size: 12px; color: #555; margin-left: auto; }
    .status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #4caf82; }
    .dot { width: 8px; height: 8px; background: #4caf82; border-radius: 50%; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .links { display: flex; gap: 12px; margin-top: 20px; }
    .btn { padding: 8px 16px; border-radius: 8px; font-size: 13px; text-decoration: none; font-weight: 500; }
    .btn-primary { background: #4f8ef7; color: #fff; }
    .btn-secondary { background: #2a2a2a; color: #aaa; border: 1px solid #333; }
  </style>
</head>
<body>
  <div class="container">
    <h1>A2A Trading System</h1>
    <p class="subtitle">Agent-to-Agent Service Marketplace &nbsp;·&nbsp; <a href="/docs">API Docs</a> &nbsp;·&nbsp; <a href="/services/search">Browse Services</a></p>

    <div class="grid">
      <div class="card">
        <div class="value">${agentCount}</div>
        <div class="label">Registered Agents</div>
      </div>
      <div class="card">
        <div class="value">${serviceCount}</div>
        <div class="label">Listed Services</div>
      </div>
      <div class="card">
        <div class="value">${orderCount}</div>
        <div class="label">Completed Orders</div>
      </div>
      <div class="card">
        <div class="value">${totalFees}</div>
        <div class="label">Platform Fees (USDC)</div>
      </div>
    </div>

    <div class="section">
      <h2>System Status</h2>
      <span class="status"><span class="dot"></span> Online</span>
      <div class="links">
        <a href="/docs" class="btn btn-primary">API Documentation</a>
        <a href="/health" class="btn btn-secondary">Health Check</a>
        <a href="/services/search" class="btn btn-secondary">Service Marketplace</a>
      </div>
    </div>

    <div class="section">
      <h2>API Endpoints</h2>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/agents/register</span><span class="desc">Register agent, get API key</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/agents/:id</span><span class="desc">Agent info & balance</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/services</span><span class="desc">List a service</span></div>
      <div class="endpoint"><span class="method get">GET</span><span class="path">/services/search</span><span class="desc">Search marketplace</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/orders</span><span class="desc">Create order (locks escrow)</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/orders/:id/deliver</span><span class="desc">Submit delivery</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/orders/:id/confirm</span><span class="desc">Confirm & release funds</span></div>
      <div class="endpoint"><span class="method post">POST</span><span class="path">/orders/:id/dispute</span><span class="desc">Open dispute</span></div>
    </div>
  </div>
</body>
</html>`);
  } catch (err) {
    res.send('<h1>A2A Trading System</h1><p>Loading...</p>');
  }
});

// API Docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

// Routes
app.use('/agents', agentRoutes);
app.use('/services', serviceRoutes);
app.use('/orders', orderRoutes);
app.use('/telegram', telegramRoutes);

// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// 全域錯誤處理
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`A2A System running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
