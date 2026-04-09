const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const openApiSpec = require('./openapi.json');

// 初始化資料庫（必須在 routes 之前）
require('./db/schema');

const agentRoutes = require('./routes/agents');
const serviceRoutes = require('./routes/services');
const orderRoutes = require('./routes/orders');
const telegramRoutes = require('./routes/telegram');
const { dbAll } = require('./db/helpers');

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

// Static frontend (SPA — public/index.html is served at /)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Stats endpoint for dashboard
app.get('/api/stats', async (req, res) => {
  try {
    const isPostgres = !!process.env.DATABASE_URL;
    const p = (n) => isPostgres ? `$${n}` : '?';
    const [agents, services, orders] = await Promise.all([
      dbAll('SELECT COUNT(*) as count FROM agents', []),
      dbAll('SELECT COUNT(*) as count FROM services', []),
      dbAll(`SELECT COUNT(*) as count, COALESCE(SUM(amount * 0.025), 0) as fees FROM orders WHERE status = ${p(1)}`, ['completed'])
    ]);
    res.json({
      agents: parseInt(agents[0].count),
      services: parseInt(services[0].count),
      completed_orders: parseInt(orders[0].count),
      platform_fees: parseFloat(orders[0].fees || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
