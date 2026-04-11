'use strict';

/**
 * idempotency.js — Prevents duplicate POST requests
 *
 * Clients send: Idempotency-Key: <uuid>
 * - First request: execute normally, cache response for 24h
 * - Repeated key: return cached response immediately (HTTP 200 + X-Idempotent-Replayed: true)
 *
 * Only applied to state-mutating POST endpoints (orders, payments, etc.).
 * GET, HEAD, OPTIONS are naturally idempotent — skip them.
 */

const { dbGet, dbRun } = require('../db/helpers');

const isPostgres = !!process.env.DATABASE_URL;
const p = (n) => isPostgres ? `$${n}` : '?';
const TTL_HOURS = 24;

/**
 * Express middleware factory.
 * Usage: router.post('/orders', idempotency(), requireApiKey, handler)
 */
function idempotency() {
  return async function idempotencyMiddleware(req, res, next) {
    // Only enforce on mutating methods
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();

    const key = req.headers['idempotency-key'];
    if (!key) return next(); // key is optional — no key means no idempotency guarantee

    if (key.length > 128) {
      return res.status(400).json({
        error: 'Idempotency-Key must be ≤ 128 characters',
        code: 'invalid_idempotency_key',
      });
    }

    try {
      // Look up existing key
      const existing = await dbGet(
        `SELECT id, status, response_status, response_body, created_at
         FROM idempotency_keys
         WHERE key_value = ${p(1)}`,
        [key]
      ).catch(() => null); // table may not exist yet on old DBs

      if (existing) {
        if (existing.status === 'processing') {
          // Another request with same key is in-flight
          return res.status(409).json({
            error: 'A request with this Idempotency-Key is already being processed.',
            code: 'idempotency_conflict',
          });
        }

        if (existing.status === 'completed') {
          // Replay cached response
          const body = typeof existing.response_body === 'string'
            ? JSON.parse(existing.response_body)
            : existing.response_body;
          res.set('X-Idempotent-Replayed', 'true');
          return res.status(existing.response_status || 200).json(body);
        }
      }

      // Mark as processing
      const expiry = isPostgres
        ? `NOW() + INTERVAL '${TTL_HOURS} hours'`
        : `datetime('now', '+${TTL_HOURS} hours')`;

      await dbRun(
        `INSERT INTO idempotency_keys (key_value, status, expires_at)
         VALUES (${p(1)}, 'processing', ${expiry})
         ON CONFLICT (key_value) DO UPDATE SET status = 'processing'`,
        [key]
      ).catch(() => {}); // non-fatal if table absent

      // Intercept res.json to capture the response
      const originalJson = res.json.bind(res);
      res.json = async function (body) {
        // Persist completed response
        const responseBody = JSON.stringify(body);
        await dbRun(
          `UPDATE idempotency_keys
           SET status = 'completed', response_status = ${p(1)}, response_body = ${p(2)}
           WHERE key_value = ${p(3)}`,
          [res.statusCode, responseBody, key]
        ).catch(() => {});
        return originalJson(body);
      };

      next();
    } catch (err) {
      // Idempotency layer failure is non-fatal — let request through
      console.error('[idempotency] middleware error:', err.message);
      next();
    }
  };
}

module.exports = { idempotency };
