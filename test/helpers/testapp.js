'use strict';

/**
 * test/helpers/testapp.js — builds a minimal Express app for integration tests.
 *
 * Mounts only the route modules needed for end-to-end lifecycle tests.
 * Avoids server.js's side effects:
 *   - no cron worker
 *   - no app.listen() on port 3000
 *   - no Swagger UI / CORS / static files
 *
 * Callers do:
 *   const { startTestApp, stopTestApp, request } = require('./helpers/testapp');
 *   const { base } = await startTestApp();
 *   const r = await request('POST', '/api/v1/agents/register', { body: {...} });
 */

// Force SQLite — never hit prod Postgres.
delete process.env.DATABASE_URL;
// Disable rate-limit for deterministic parallel tests.
process.env.DISABLE_RATE_LIMIT = '1';
process.env.NODE_ENV = 'test';

const express = require('express');
require('../../src/db/schema');

function buildApp() {
  const app = express();
  app.use(express.json());

  // Mount v1 routes (subset enough for lifecycle tests).
  const v1 = express.Router();
  v1.use('/agents',        require('../../src/routes/agents'));
  v1.use('/services',      require('../../src/routes/services'));
  v1.use('/orders',        require('../../src/routes/orders'));
  v1.use('/withdrawals',   require('../../src/routes/withdrawals'));
  v1.use('/notifications', require('../../src/routes/notifications'));

  app.use('/api/v1', v1);

  // Simple 404 so tests fail loudly on typos instead of hanging.
  app.use((req, res) => res.status(404).json({ error: 'not found in test app', path: req.path }));

  // Standardize error responses.
  app.use((err, req, res, next) => {
    console.error('[testapp] route error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return app;
}

let _server = null;
let _base   = null;

async function startTestApp() {
  if (_server) return { base: _base };
  const app = buildApp();
  await new Promise((resolve) => {
    _server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = _server.address();
  _base = `http://127.0.0.1:${port}`;
  return { base: _base };
}

async function stopTestApp() {
  if (!_server) return;
  await new Promise((resolve) => _server.close(() => resolve()));
  _server = null;
  _base = null;
}

async function request(method, path, { body, headers = {} } = {}) {
  if (!_base) throw new Error('Call startTestApp() before request()');
  const res = await fetch(_base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  return { status: res.status, body: json, headers: Object.fromEntries(res.headers.entries()), text };
}

module.exports = { startTestApp, stopTestApp, request, buildApp };
