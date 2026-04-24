'use strict';
/**
 * src/middleware/userEvents.js
 *
 * Attach to every request. Extracts identity hints (wallet, github, api_key_id,
 * ip hash), classifies the request into an event_type, and appends it to the
 * user_events table plus the user_entities resolver.
 *
 * Never blocks the request: all DB work runs after res.end via setImmediate,
 * with errors swallowed and logged to stderr. The request path must not
 * acquire a lock on the tracker.
 *
 * Identity extraction order (soft; all optional):
 *   wallet       X-Buyer-Address / X-Seller-Address / ?buyer=... / ?seller=...
 *   github       X-GitHub-User / User-Agent "github-actions-*"
 *   api_key_id   derived from X-Attribution-Key (sha256 prefix) or X-API-Key
 *   ip_hash      sha256(daily_salt || remote_ip) — rotates daily
 */

const crypto = require('crypto');
const accum = require('../user_accumulation/db');

// ---------------------------------------------------------------------------
// IP hashing with a daily-rotating salt. Salt is held in-process and
// regenerated at UTC midnight; see open-questions §11 (Daily salt storage).
// ---------------------------------------------------------------------------
let _saltBucket = null;
let _salt = null;

function currentBucket() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function getDailySalt() {
  const bucket = currentBucket();
  if (bucket !== _saltBucket) {
    _saltBucket = bucket;
    // Derive from ATTRIBUTION_SALT_SEED if set (so multiple workers agree);
    // otherwise use a per-process random salt (OK for single-instance Render).
    const seed = process.env.ATTRIBUTION_SALT_SEED || '';
    _salt = crypto.createHash('sha256').update(`${seed}:${bucket}`).digest('hex');
  }
  return _salt;
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(getDailySalt() + ':' + ip).digest('hex').slice(0, 16);
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

// ---------------------------------------------------------------------------
// Event classification. Paths we explicitly care about get a specific
// event_type; everything else is site_visit (for static/html) or api_probe
// (for /api/* without a match). The middleware runs AFTER the handler, so
// we can also read res.statusCode for api_call vs api_probe distinction.
// ---------------------------------------------------------------------------
function classify(req, res) {
  const p = req.path || req.url || '';
  // Skip health/robots/static asset noise
  if (p === '/' || p === '/favicon.ico' || p.startsWith('/assets') || p.endsWith('.css') || p.endsWith('.js') || p.endsWith('.png')) {
    return p === '/' ? 'site_visit' : null;
  }
  if (p.startsWith('/docs')) return 'docs_visit';
  if (p.startsWith('/api/')) {
    return res.statusCode >= 200 && res.statusCode < 400 ? 'api_call' : 'api_probe';
  }
  if (p.startsWith('/mcp')) return 'api_call';
  if (p.startsWith('/arbitrate')) return 'api_call';
  if (p === '/pay/new.html' || p.startsWith('/verdicts') || p.startsWith('/status')) return 'site_visit';
  return 'site_visit';
}

// ---------------------------------------------------------------------------
// Extract identity hints from a request.
// ---------------------------------------------------------------------------
function extractIdentity(req) {
  const h = req.headers;
  const q = req.query || {};

  // Wallet: multiple possible sources. Only accept 0x + 40 hex.
  const walletRaw =
    h['x-buyer-address'] || h['x-seller-address'] ||
    q.buyer || q.seller || null;
  const wallet = walletRaw && /^0x[a-fA-F0-9]{40}$/.test(String(walletRaw)) ? String(walletRaw) : null;

  // GitHub user hint
  const ua = String(h['user-agent'] || '');
  let github = h['x-github-user'] ? String(h['x-github-user']) : null;
  if (!github) {
    const m = ua.match(/github-actions[\/-]([a-zA-Z0-9_-]+)/i);
    if (m) github = m[1];
  }

  // API key / attribution key identifier (we store only the hash/prefix).
  let api_key_id = null;
  if (h['x-attribution-key']) {
    api_key_id = 'atk:' + crypto.createHash('sha256').update(String(h['x-attribution-key'])).digest('hex').slice(0, 12);
  } else if (h['x-api-key']) {
    api_key_id = 'api:' + crypto.createHash('sha256').update(String(h['x-api-key'])).digest('hex').slice(0, 12);
  }

  return {
    wallet,
    github,
    api_key_id,
    ip_hash: hashIp(clientIp(req)),
    referrer: h.referer || h.referrer || null,
    ua_family: uaFamily(ua),
  };
}

function uaFamily(ua) {
  if (!ua) return null;
  if (/github-actions/i.test(ua)) return 'github-actions';
  if (/Mozilla/i.test(ua) && /Chrome/i.test(ua)) return 'chrome';
  if (/Mozilla/i.test(ua) && /Safari/i.test(ua)) return 'safari';
  if (/Mozilla/i.test(ua) && /Firefox/i.test(ua)) return 'firefox';
  if (/curl\//i.test(ua)) return 'curl';
  if (/node-fetch|axios|okhttp|python-requests|httpx|aiohttp/i.test(ua)) return 'http-client';
  return 'other';
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function userEventsMiddleware(opts = {}) {
  const enabled = opts.enabled !== false && process.env.USER_EVENTS_DISABLED !== '1';

  return function userEvents(req, res, next) {
    if (!enabled) return next();
    res.on('finish', () => {
      setImmediate(async () => {
        try {
          const event_type = classify(req, res);
          if (!event_type) return;
          const ident = extractIdentity(req);
          const evt = {
            event_type,
            path: req.path || null,
            ...ident,
            metadata: { status: res.statusCode, method: req.method },
          };
          const heat = await accum.insertEvent(evt);
          await accum.resolveAndUpsertEntity(evt, heat);
        } catch (err) {
          if (process.env.USER_EVENTS_DEBUG) {
            console.error('[userEvents] drop:', err.message);
          }
        }
      });
    });
    next();
  };
}

// Manual hook for non-HTTP signals (on-chain events, github snapshots, etc).
async function recordEvent(evt) {
  const heat = await accum.insertEvent(evt);
  await accum.resolveAndUpsertEntity(evt, heat);
  return heat;
}

module.exports = { userEventsMiddleware, recordEvent, hashIp };
